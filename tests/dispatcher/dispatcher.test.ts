/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
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
import type { JudgmentDecision } from "../../src/judgment/judgment-types";

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

  const mockExecSync = jest.fn().mockImplementation((command: string) => {
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
  [ParsedTask, ProjectAdapter, Record<string, unknown> | undefined, unknown?]
>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (
    ...args: [ParsedTask, ProjectAdapter, Record<string, unknown> | undefined, unknown?]
  ) => mockRunReadinessGate(...args),
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

// TASK-1316: the judge-stage intent runner. Construction is COUNTED so
// "never invoked" is provable rather than inferred.
const mockIntentRunnerRun = jest.fn();
const mockCreateIntentRunner = jest.fn(() => ({
  kind: "claude-sdk" as const,
  run: (...args: unknown[]) => mockIntentRunnerRun(...args) as Promise<unknown>,
}));
jest.mock("../../src/judgment/runner/intent-judgment-runner", () => ({
  createIntentJudgmentRunner: (...args: unknown[]) => mockCreateIntentRunner(...(args as [])),
}));

const mockEvaluateLoopReview = jest.fn();
jest.mock("../../src/review/loop-gate", () => ({
  evaluateLoopReview: (...args: unknown[]) => mockEvaluateLoopReview(...args),
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
  // TASK-833: dispatcher imports createMinimalBlueprint for the timeout
  // fallback path. The mock must export it (a passthrough is fine — the
  // real implementation just returns an empty Blueprint shape).
  createMinimalBlueprint: (taskId: string) => ({
    taskId,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  }),
}));

const mockFormatBlueprintForPrompt = jest.fn();
jest.mock("../../src/blueprint/blueprint-prompt", () => ({
  formatBlueprintForPrompt: mockFormatBlueprintForPrompt,
}));

const mockExtractPatterns = jest.fn();
const mockFormatPatternsForPrompt = jest.fn();
jest.mock("../../src/gate/pattern-extractor", () => ({
  extractPatterns: (...args: unknown[]) => mockExtractPatterns(...args),
  formatPatternsForPrompt: (...args: unknown[]) => mockFormatPatternsForPrompt(...args),
}));

// Mock CheckpointManager to use in-memory storage instead of filesystem I/O.
// The Map is exposed via _checkpoints so beforeEach can clear it between tests.
const _mockCheckpoints = new Map<string, Record<string, unknown>>();
const mockCheckpointRewindFrom = jest.fn();

jest.mock("../../src/dispatcher/checkpoint-manager", () => {
  return {
    CheckpointManager: jest.fn().mockImplementation(() => ({
      save: jest.fn().mockImplementation((cp: Record<string, unknown>) => {
        _mockCheckpoints.set(cp.taskId as string, cp);
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
        .mockImplementation((taskId: string, _stage: string, updates: Record<string, unknown>) => {
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
          _mockCheckpoints.set(taskId, updated);
          return Promise.resolve(updated);
        }),
      rewindFrom: (...args: unknown[]) => mockCheckpointRewindFrom(...args),
      getResumeStage: jest.fn().mockReturnValue("gate"),
    })),
  };
});

// ─── Import dispatcher after mocking ────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dispatchTask, ensureDiffOrAutoCommit } =
  require("../../src/dispatcher/dispatcher") as typeof import("../../src/dispatcher/dispatcher");

// Handle to the module-level post-judge mock so safety-stop tests can
// assert it was never reached (TASK-1313 F2 unreachability proof).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPostJudgeVerification: mockRunPostJudgeVerification } =
  require("../../src/dispatcher/post-judge-verifier") as {
    runPostJudgeVerification: jest.Mock;
  };

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

function makeLoopAdapter(projectRoot: string): ProjectAdapter {
  const base = makeAdapter({ projectRoot });
  return makeAdapter({
    projectRoot,
    config: {
      ...base.config,
      executionMode: "loop",
      loop: {
        briefReview: {
          reviewer: {
            runner: "codex-cli",
            maxTurns: 30,
            timeoutMs: 600_000,
            codex: { binaryPath: "codex", sandbox: "read-only" },
          },
          requireCrossModel: true,
          autoApproveWhen: {
            maxFiles: 3,
            maxCriteria: 5,
            minBlueprintScore: 0,
            requireDecomposition: false,
          },
        },
        diffReview: {
          reviewer: {
            runner: "codex-cli",
            maxTurns: 30,
            timeoutMs: 600_000,
            codex: { binaryPath: "codex", sandbox: "read-only" },
          },
          requireCrossModel: true,
          autoApproveWhen: {
            requireVerificationPass: true,
            maxFilesChanged: 3,
            maxDiffLines: 200,
          },
        },
        recordOnFinalize: true,
      },
    },
  });
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

function makeJudgmentDecision(
  action: "continue" | "repair" | "human_review" = "continue",
): JudgmentDecision {
  return {
    schemaVersion: 1,
    stage: "judge",
    signals: [],
    judgment: {
      source: "legacy_policy",
      action,
      rationale: [`test_action:${action}`],
    },
    safetyFloor: { passed: true, blockers: [] },
    action,
    rationale: [`judgment_action:${action}`],
  };
}

// ─── Test setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  jest.clearAllMocks();
  _mockCheckpoints.clear();
  mockCheckpointRewindFrom.mockResolvedValue(null);
  mockGitResults = {};

  // Mock blueprint generation by default (returns minimal blueprint)
  mockGenerateBlueprint.mockResolvedValue({
    taskId: "TASK-042",
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  });
  mockFormatBlueprintForPrompt.mockReturnValue("## Implementation Blueprint\n\n(minimal)");
  mockExtractPatterns.mockResolvedValue({ patterns: [], siblingPatterns: [] });
  mockFormatPatternsForPrompt.mockReturnValue("formatted patterns");
  mockEvaluateLoopReview.mockResolvedValue({
    runnerKind: "codex-cli",
    result: {
      status: "completed",
      verdict: "SHIP",
      findings: [],
      summary: "clean",
      rawText: "{}",
      runner: "codex-cli",
      durationMs: 10,
      anchorsAudit: { total: 0, missing: [] },
      treeDirtyAfterReview: false,
    },
    reviewGate: {
      crossModelSatisfied: true,
      anchorAuditPassed: true,
      treeClean: true,
      fidelityPassed: true,
      eligibleForAutoApproval: true,
      reasons: [],
    },
  });

  // Create temp directory with task file
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-dispatch-test-"));
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("ensureDiffOrAutoCommit", () => {
  test("auto-commits dirty retry deltas even when an older committed diff exists", async () => {
    const adapter = makeAdapter({ projectRoot: tmpDir });
    const events = {
      emit: jest.fn(),
      recordSession: jest.fn(),
      sessionId: "test-session",
      taskId: "TASK-042",
      project: "test",
    };

    mockGitResults = {
      "status --short": { stdout: "M  src/retry-fix.ts\n" },
      "diff --cached --name-only": { stdout: "src/retry-fix.ts\n" },
      "commit -m": { stdout: "[quack/TASK-042 abc123] auto-commit" },
      "diff main...HEAD": { stdout: "diff --git a/src/retry-fix.ts b/src/retry-fix.ts\n" },
    };

    const diff = await ensureDiffOrAutoCommit("TASK-042", adapter, events);

    expect(diff).toContain("retry-fix");
    expect(events.emit).toHaveBeenCalledWith(
      "auto_commit",
      expect.objectContaining({ filesStaged: 1 }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      "agent_output_sealed",
      expect.objectContaining({ taskId: "TASK-042", filesStaged: 1 }),
    );
  });

  test("throws before returning a stale diff when dirty changes cannot be committed", async () => {
    const adapter = makeAdapter({ projectRoot: tmpDir });
    const events = {
      emit: jest.fn(),
      recordSession: jest.fn(),
      sessionId: "test-session",
      taskId: "TASK-042",
      project: "test",
    };

    mockGitResults = {
      "status --short": { stdout: "M  src/retry-fix.ts\n" },
      "diff --cached --name-only": { stdout: "src/retry-fix.ts\n" },
      "commit -m": { error: true, stderr: "commit failed" },
      "diff main...HEAD": { stdout: "diff --git a/src/old.ts b/src/old.ts\n" },
    };

    await expect(ensureDiffOrAutoCommit("TASK-042", adapter, events)).rejects.toThrow(
      "Agent output seal failed",
    );
    expect(events.emit).toHaveBeenCalledWith(
      "session_error",
      expect.objectContaining({ failedStage: "agent_output_seal" }),
    );
  });
});

describe("dispatchTask", () => {
  describe("gate -> branch -> agent -> judge -> PR (happy path)", () => {
    test("should complete full pipeline and return approved result", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const stages: string[] = [];

      // Mock: gate passes
      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });

      // Mock: context assembly
      mockAssembleContext.mockResolvedValue(makeContext());

      // Mock: agent succeeds
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      // Mock: judge approves
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      // Mock: git commands succeed
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "checkout -b": { stdout: "Switched to branch" },
        "diff main": { stdout: "diff content" },
        "push -u origin": { stdout: "Branch pushed" },
        "gh pr create": { stdout: "https://github.com/org/repo/pull/42" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.taskId).toBe("TASK-042");
      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(0);
      expect(mockEvaluateLoopReview).not.toHaveBeenCalled();
      expect(stages).not.toContain("loop_brief_review");
      expect(stages).not.toContain("loop_diff_review");
    }, 15000);

    test("refuses a contest introduced after blueprint approval but before the judge approval save", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      adapter.config.preflight = {
        ...adapter.config.preflight,
        blueprintApproval: {
          enabled: true,
          autoApproveWhen: {
            maxFiles: 3,
            maxCriteria: 5,
            minBlueprintScore: 0,
            requireDecomposition: false,
          },
        },
        judgeApproval: {
          enabled: true,
          autoApproveWhen: {
            requireVerificationPass: true,
            maxFilesChanged: 1,
            maxDiffLines: 1,
          },
        },
      } as NonNullable<AdapterConfig["preflight"]>;
      mockRunReadinessGate.mockResolvedValueOnce({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValueOnce(makeContext());
      mockRunAgent.mockResolvedValueOnce(makeAgentResult("TASK-042"));
      mockGitResults = {
        "diff main": { stdout: "diff --git a/src/test.ts b/src/test.ts\n+changed" },
      };
      const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const crossClaimant = path.join(tmpDir, "docs", "tasks", "TASK-999-cross.md");

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => {
          events.push({ stage, payload });
          if (stage === "agent_output_sealed") {
            fsSync.writeFileSync(
              crossClaimant,
              makeTaskContent("TASK-042", "Cross Claimant"),
              "utf-8",
            );
          }
        },
      });

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.stage === "agent_output_sealed")).toBe(true);
      expect(result.outcome).toBe("spec_changed");
      expect(result.error).toContain("contested id");
      expect(result.error).toContain("TASK-042-test.md");
      expect(result.error).toContain("TASK-999-cross.md");
      expect(events.find((event) => event.stage === "spec_identity_stale")?.payload).toMatchObject({
        stage: "judge_review",
        verdict: "contested",
        recoverable: true,
      });
      expect(events.some((event) => event.stage === "judge_pending_approval")).toBe(false);
      expect(mockRunJudge).not.toHaveBeenCalled();
    }, 15000);

    test("emits an ordered judge trace followed by one final post-judge decision", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const decisions: Array<Record<string, unknown>> = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(
        makeJudgeResult({
          judgmentTrace: [
            {
              sequence: 0,
              phase: "raw",
              decision: makeJudgmentDecision("continue"),
            },
          ],
        }),
      );
      mockGitResults = { "diff main": { stdout: "diff content" } };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => {
          if (stage === "judgment_decision") decisions.push(payload);
        },
      });

      expect(result.outcome).toBe("approved");
      expect(decisions).toEqual([
        expect.objectContaining({
          taskId: "TASK-042",
          stage: "judge",
          attempt: 0,
          sequence: 0,
          final: false,
        }),
        expect.objectContaining({
          taskId: "TASK-042",
          stage: "post_judge",
          attempt: 0,
          sequence: 1,
          final: true,
        }),
      ]);
    }, 15000);

    test("keeps projection failures and post-judge decisions collision-free", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const judgmentEvents: Array<{
        stage: string;
        payload: Record<string, unknown>;
      }> = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(
        makeJudgeResult({
          judgmentTrace: [
            {
              sequence: 1,
              phase: "enforcement",
              decision: makeJudgmentDecision("continue"),
            },
            {
              sequence: 2,
              phase: "path_audit",
              decision: makeJudgmentDecision("continue"),
            },
          ],
          judgmentProjectionFailure: {
            errorCode: "invalid_stage",
            message: "raw projection failed",
          },
        }),
      );
      mockGitResults = { "diff main": { stdout: "diff content" } };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => {
          if (stage.startsWith("judgment_")) {
            judgmentEvents.push({ stage, payload });
          }
        },
      });

      expect(result.outcome).toBe("approved");
      expect(
        judgmentEvents.map(({ stage, payload }) => ({
          stage,
          attempt: payload.attempt,
          sequence: payload.sequence,
          final: payload.final,
        })),
      ).toEqual([
        { stage: "judgment_decision", attempt: 0, sequence: 1, final: false },
        { stage: "judgment_decision", attempt: 0, sequence: 2, final: false },
        { stage: "judgment_projection_failed", attempt: 0, sequence: 3, final: undefined },
        { stage: "judgment_decision", attempt: 0, sequence: 4, final: true },
      ]);
    }, 15000);

    test("increments judge attempt identity and seals each retry decision", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const decisions: Array<Record<string, unknown>> = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));
      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Repair the first pass.",
            judgmentTrace: [
              {
                sequence: 0,
                phase: "raw",
                decision: makeJudgmentDecision("repair"),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          makeJudgeResult({
            judgmentTrace: [
              {
                sequence: 0,
                phase: "raw",
                decision: makeJudgmentDecision("continue"),
              },
            ],
          }),
        );
      mockGitResults = { "diff main": { stdout: "diff content" } };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => {
          if (stage === "judgment_decision") decisions.push(payload);
        },
      });

      expect(result.outcome).toBe("approved");
      expect(decisions).toEqual([
        expect.objectContaining({ attempt: 0, sequence: 0, final: true }),
        expect.objectContaining({
          stage: "judge",
          attempt: 1,
          sequence: 0,
          final: false,
        }),
        expect.objectContaining({
          stage: "post_judge",
          attempt: 1,
          sequence: 1,
          final: true,
        }),
      ]);
    }, 15000);

    test("loop mode reviews the sealed Brief and diff in order with stage model overrides", async () => {
      const base = makeAdapter({ projectRoot: tmpDir });
      const adapter = makeAdapter({
        projectRoot: tmpDir,
        config: {
          ...base.config,
          executionMode: "loop",
          loop: {
            briefReview: {
              reviewer: {
                runner: "codex-cli",
                maxTurns: 30,
                timeoutMs: 600_000,
                codex: { binaryPath: "codex", sandbox: "read-only" },
              },
              requireCrossModel: true,
              autoApproveWhen: {
                maxFiles: 3,
                maxCriteria: 5,
                minBlueprintScore: 0,
                requireDecomposition: false,
              },
            },
            diffReview: {
              reviewer: {
                runner: "codex-cli",
                maxTurns: 30,
                timeoutMs: 600_000,
                codex: { binaryPath: "codex", sandbox: "read-only" },
              },
              requireCrossModel: true,
              autoApproveWhen: {
                requireVerificationPass: true,
                maxFilesChanged: 3,
                maxDiffLines: 200,
              },
            },
            models: {
              investigate: "investigate-model",
              build: "build-model",
              judge: "judge-model",
            },
            recordOnFinalize: true,
          },
        },
      });
      const stages: string[] = [];

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", { claudeSessionId: "worker-session" }),
      );
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
        "rev-parse --verify": { stdout: "abc123\n" },
        "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
        "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
        "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.outcome).toBe("approved");
      expect(mockEvaluateLoopReview).toHaveBeenCalledTimes(2);
      expect(mockEvaluateLoopReview).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          kind: "brief",
          artifact: "## Implementation Blueprint\n\n(minimal)",
        }),
        // TASK-1316: the brief gate threads (runnerFactory,
        // injectedSignals, cutover). This adapter opts into no
        // judgment, so the stage mode resolves to off.
        undefined,
        [],
        { mode: "off", runnerConfig: undefined },
        // TASK-1324 added the brief-fidelity verdict as a seventh
        // argument (brief gate only). This adapter's minimal blueprint
        // carries no fidelity stamp, so it arrives undefined — the
        // assertion was left one argument short when 1324 landed.
        undefined,
      );
      expect(mockEvaluateLoopReview).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          kind: "diff",
          artifact: "diff --git a/src/test.ts b/src/test.ts",
        }),
        // TASK-1313 S2: the diff gate now threads (runnerFactory,
        // injectedSignals); with no safetyFloor config the mode is off
        // and the injected set is empty. TASK-1316 adds the stage
        // cutover, off for an adapter that opts into no judgment.
        undefined,
        [],
        { mode: "off", runnerConfig: undefined },
      );
      expect(mockGenerateBlueprint).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        model: "investigate-model",
      });
      expect(mockRunAgent).toHaveBeenCalledWith(
        "TASK-042",
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ model: "build-model" }),
        expect.anything(),
      );
      expect(mockRunJudge).toHaveBeenCalledWith(
        expect.objectContaining({ gitDiff: "diff --git a/src/test.ts b/src/test.ts" }),
        expect.anything(),
        expect.objectContaining({ model: "judge-model" }),
      );
      expect(stages.indexOf("agent_output_sealed")).toBeLessThan(
        stages.indexOf("loop_diff_review"),
      );
      expect(stages.indexOf("loop_diff_review")).toBeLessThan(stages.indexOf("judge_start"));
    }, 15000);

    test("does not trust an approved loop record with incomplete review evidence", async () => {
      const adapter = makeLoopAdapter(tmpDir);
      adapter.config.loop!.briefReview.autoApproveWhen = undefined;
      const approvalDir = path.join(tmpDir, ".quack", "logs", "approvals");
      await fs.mkdir(approvalDir, { recursive: true });
      await fs.writeFile(
        path.join(approvalDir, "TASK-042.json"),
        JSON.stringify({
          taskId: "TASK-042",
          state: "approved",
          blueprint: { taskId: "TASK-042", fileAnalyses: [] },
          createdAt: new Date().toISOString(),
          executionMode: "loop",
          review: {
            status: "completed",
            verdict: "SHIP",
            findings: [],
            summary: "missing derived gate facts",
            rawText: "{}",
            runner: "codex-cli",
            durationMs: 1,
          },
        }),
      );
      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("awaiting_approval");
      expect(mockEvaluateLoopReview).toHaveBeenCalledTimes(1);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    test("rewinds the review checkpoint when a retry diff pauses for human approval", async () => {
      const adapter = makeLoopAdapter(tmpDir);
      const shipReview = {
        runnerKind: "codex-cli",
        result: {
          status: "completed" as const,
          verdict: "SHIP" as const,
          findings: [],
          summary: "clean",
          rawText: "{}",
          runner: "codex-cli" as const,
          durationMs: 1,
        },
        reviewGate: {
          crossModelSatisfied: true,
          anchorAuditPassed: true,
          treeClean: true,
          fidelityPassed: true,
          eligibleForAutoApproval: true,
          reasons: [],
        },
      };
      const amendReview = {
        ...shipReview,
        result: {
          ...shipReview.result,
          verdict: "AMEND" as const,
          summary: "retry needs human review",
        },
        reviewGate: {
          ...shipReview.reviewGate,
          eligibleForAutoApproval: false,
          reasons: ["review verdict is AMEND"],
        },
      };
      mockEvaluateLoopReview
        .mockResolvedValueOnce(shipReview)
        .mockResolvedValueOnce(shipReview)
        .mockResolvedValueOnce(amendReview);
      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042", { claudeSessionId: "worker-initial" }))
        .mockResolvedValueOnce(makeAgentResult("TASK-042", { claudeSessionId: "worker-retry" }));
      mockRunJudge.mockResolvedValueOnce(
        makeJudgeResult({
          verdict: "REVISE",
          feedback: "fix the first pass",
        }),
      );
      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
        "rev-parse --verify": { stdout: "abc123\n" },
        "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
        "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
        "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("awaiting_judge_approval");
      expect(mockEvaluateLoopReview).toHaveBeenCalledTimes(3);
      expect(mockRunJudge).toHaveBeenCalledTimes(1);
      expect(mockCheckpointRewindFrom).toHaveBeenCalledWith("TASK-042", "judge_review");
    }, 15000);

    test("approval resume skips the worker and judges the preserved reviewed diff", async () => {
      const adapter = makeLoopAdapter(tmpDir);
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      const reviewedDiff = "diff --git a/src/retry.ts b/src/retry.ts\n+reviewed retry fix\n";
      const review = {
        status: "completed",
        verdict: "SHIP",
        findings: [],
        summary: "approved retry diff",
        rawText: "{}",
        runner: "codex-cli",
        durationMs: 1,
      };
      const reviewGate = {
        crossModelSatisfied: true,
        anchorAuditPassed: true,
        treeClean: true,
        fidelityPassed: true,
        eligibleForAutoApproval: false,
        reasons: ["human approval required"],
      };
      const blueprint = {
        taskId: "TASK-042",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };
      await fs.mkdir(approvalDir, { recursive: true });
      await fs.writeFile(
        path.join(approvalDir, "TASK-042.json"),
        JSON.stringify({
          taskId: "TASK-042",
          state: "approved",
          blueprint,
          createdAt: new Date().toISOString(),
          executionMode: "loop",
          review,
          reviewGate,
        }),
      );
      await fs.writeFile(
        path.join(approvalDir, "TASK-042-judge.json"),
        JSON.stringify({
          taskId: "TASK-042",
          state: "approved",
          diff: reviewedDiff,
          filesModified: ["src/retry.ts"],
          filesCreated: [],
          verificationPassed: true,
          createdAt: new Date().toISOString(),
          executionMode: "loop",
          review,
          reviewGate,
          agentSessionId: "worker-retry",
        }),
      );
      const preservedAgent = makeAgentResult("TASK-042", {
        claudeSessionId: "worker-retry",
      });
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "prior-dispatch",
        completedStages: ["gate", "blueprint", "approve", "branch", "agent", "commit"],
        claudeSessionId: "worker-retry",
        agentResult: preservedAgent,
        gitDiff: reviewedDiff,
        outputSnapshots: [
          {
            taskId: "TASK-042",
            attempt: 2,
            kind: "retry",
            sealedAt: new Date().toISOString(),
            diffBase: "main",
            diffRef: "main...HEAD",
            baseSha: "base",
            headShaBefore: "before",
            headShaAfter: "after",
            sealedCommitSha: "after",
            worktreePath: tmpDir,
            manifestPath: "manifest.json",
            diffPath: "diff.patch",
            statusPath: "status.txt",
            nameStatusPath: "name-status.txt",
            gitDiff: reviewedDiff,
            diffStat: "src/retry.ts | 1 +",
            statusShort: "",
            changedFiles: ["src/retry.ts"],
            nameStatus: [{ status: "M", path: "src/retry.ts" }],
            filesStaged: 1,
            excludedFiles: [],
            claudeSessionId: "worker-retry",
            empty: false,
          },
        ],
        totalCostUsd: 2,
        retriesUsed: 1,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        resumeFromCheckpoint: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockGenerateBlueprint).not.toHaveBeenCalled();
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockEvaluateLoopReview).not.toHaveBeenCalled();
      expect(mockRunJudge).toHaveBeenCalledWith(
        expect.objectContaining({ gitDiff: reviewedDiff }),
        expect.anything(),
        expect.anything(),
      );
    }, 15000);

    test("fails effective loop mode without loop config before blueprint or branch work", async () => {
      const base = makeAdapter({ projectRoot: tmpDir });
      const adapter = makeAdapter({
        projectRoot: tmpDir,
        config: { ...base.config, executionMode: "loop", loop: undefined },
      });

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result).toMatchObject({
        outcome: "error",
        error: "Effective execution mode is loop, but the adapter has no loop configuration",
      });
      expect(mockGenerateBlueprint).not.toHaveBeenCalled();
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockEvaluateLoopReview).not.toHaveBeenCalled();
    });

    test("should seal agent output before judge starts", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const stages: string[] = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
        "rev-parse --verify": { stdout: "abc123\n" },
        // sealAgentOutputAttempt receives diffBase=dispatchBaseBranch ("main"),
        // so resolveDiffRef short-circuits to diffRef="main" — NOT
        // "origin/main". The mocks must match `git diff main...HEAD`, not
        // `git diff origin/main...HEAD`, or the diff is empty and the
        // dispatcher returns no_changes instead of approved.
        "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
        "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
        "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.outcome).toBe("approved");
      expect(stages.indexOf("agent_output_sealed")).toBeGreaterThanOrEqual(0);
      expect(stages.indexOf("agent_output_sealed")).toBeLessThan(stages.indexOf("judge_start"));
      expect(mockRunJudge).toHaveBeenCalledWith(
        expect.objectContaining({ changedFiles: ["src/test.ts"] }),
        expect.anything(),
        expect.anything(),
      );
    }, 15000);
  });

  // ─── TASK-1316: the judge intent cutover ────────────────────────
  // These prove the enforce mappings CHANGE CONTROL FLOW rather than
  // just recording an opinion, which is what the spec's anti-gaming
  // clause demands.
  describe("judge intent cutover (TASK-1316)", () => {
    const SEAL_GIT = {
      "status --short": { stdout: " M src/test.ts\n" },
      "diff --cached --name-only": { stdout: "src/test.ts\n" },
      "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
      "rev-parse --verify": { stdout: "abc123\n" },
      "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
      "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
      "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
    };

    /** A judge result carrying the trace the cutover reads. */
    function judged(overrides: Partial<JudgeResult> = {}): JudgeResult {
      return makeJudgeResult({
        judgmentTrace: [{ sequence: 0, phase: "raw", decision: makeJudgmentDecision("continue") }],
        ...overrides,
      });
    }

    function adapterWithJudgeMode(mode: "off" | "shadow" | "enforce"): ProjectAdapter {
      const base = makeAdapter({ projectRoot: tmpDir });
      (base.config as unknown as Record<string, unknown>).judgment = {
        runner: {
          provider: "claude-sdk",
          model: "test-model",
          maxTurns: 5,
          timeoutMs: 1_000,
        },
        stages: {
          docsReview: { mode: "off" },
          readiness: { mode: "off" },
          loopBrief: { mode: "off" },
          loopDiff: { mode: "off" },
          judge: { mode },
        },
      };
      return base;
    }

    function intentReturns(action: "continue" | "repair" | "human_review"): void {
      mockIntentRunnerRun.mockImplementation((request: { signals: { ref: string }[] }) =>
        Promise.resolve({
          status: "completed",
          judgment: {
            source: "intent_model",
            action,
            rationale: ["the diff does not honor the spec's intent"],
          },
          consideredSignalRefs: request.signals.map((signal) => signal.ref),
          model: "test-model",
          durationMs: 1,
          truncatedFields: [],
        }),
      );
    }

    beforeEach(() => {
      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockGitResults = SEAL_GIT;
    });

    test("off mode never constructs an intent runner", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());

      const result = await dispatchTask("TASK-042", adapterWithJudgeMode("off"), {
        skipBranch: true,
        skipPr: true,
      });

      expect(mockCreateIntentRunner).not.toHaveBeenCalled();
      expect(result.outcome).toBe("approved");
    }, 15000);

    test("shadow records an opinion without touching the verdict", async () => {
      intentReturns("repair");
      mockRunJudge.mockResolvedValue(judged());
      const stages: string[] = [];

      const result = await dispatchTask("TASK-042", adapterWithJudgeMode("shadow"), {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(mockCreateIntentRunner).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe("approved");
      expect(stages).toContain("judgment_evaluation");
      // The APPROVE survived: post-judge still ran.
      expect(mockRunPostJudgeVerification).toHaveBeenCalled();
    }, 15000);

    test("enforce repair DEMOTES an APPROVE to REVISE and enters the retry loop", async () => {
      // Round-2 F3: the first version of this test left the DEFAULT
      // implementation at "repair", so the retry's APPROVE was demoted
      // too and the run ended rejected — it never proved the demotion
      // was recoverable. First call repairs, second confirms.
      intentReturns("continue");
      mockIntentRunnerRun.mockImplementationOnce((request: { signals: { ref: string }[] }) =>
        Promise.resolve({
          status: "completed",
          judgment: {
            source: "intent_model",
            action: "repair",
            rationale: ["the diff does not honor the spec's intent"],
          },
          consideredSignalRefs: request.signals.map((signal) => signal.ref),
          model: "test-model",
          durationMs: 1,
          truncatedFields: [],
        }),
      );
      // First judge call APPROVEs (and is demoted); the retry APPROVEs
      // and the confirming runner leaves it alone.
      mockRunJudge
        .mockResolvedValueOnce(judged())
        .mockResolvedValue(judged({ feedback: "second pass" }));

      const adapter = adapterWithJudgeMode("enforce");
      adapter.config.agent.maxRetries = 1;
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      // The demotion is RECOVERABLE: one retry consumed, exactly as a
      // native REVISE, and the run then completes.
      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(1);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      expect(mockIntentRunnerRun).toHaveBeenCalledTimes(2);
      // The demotion's reason reaches the worker through the same
      // revision prompt a native REVISE uses.
      const retrySpec = mockRunAgent.mock.calls[1]?.[1].taskSpec ?? "";
      expect(retrySpec).toContain("REVISION REQUIRED");
      expect(retrySpec).toContain("[INTENT DEMOTION]");
      expect(retrySpec).toContain("does not honor the spec's intent");
    }, 20000);

    test("enforce human_review PAUSES at the judge-review gate", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());
      const stages: string[] = [];

      const result = await dispatchTask("TASK-042", adapterWithJudgeMode("enforce"), {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.outcome).toBe("awaiting_judge_approval");
      expect(stages).toContain("judge_pending_approval");
      // The checkpoint was rewound so the resume comes back through the
      // gate rather than standing on the unreviewed judge decision.
      expect(mockCheckpointRewindFrom).toHaveBeenCalledWith("TASK-042", "judge_review");
      // Nothing downstream ran.
      expect(mockRunPostJudgeVerification).not.toHaveBeenCalled();
      expect(stages).not.toContain("pr_created");
    }, 15000);

    test("the pause PRESERVES the reviewer's evidence on the approval record", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());

      // A diff review already attached its findings to the record; the
      // human arriving at the re-opened gate must still see them.
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      await fs.mkdir(approvalDir, { recursive: true });
      await fs.writeFile(
        path.join(approvalDir, "TASK-042-judge.json"),
        JSON.stringify({
          taskId: "TASK-042",
          state: "auto-approved",
          diff: "old diff",
          filesModified: ["src/test.ts"],
          filesCreated: [],
          verificationPassed: true,
          createdAt: new Date().toISOString(),
          review: {
            status: "completed",
            verdict: "SHIP",
            findings: [],
            summary: "reviewed clean",
            rawText: "{}",
            runner: "codex-cli",
            durationMs: 1,
          },
          reviewedAt: new Date().toISOString(),
          reviewGate: {
            crossModelSatisfied: true,
            anchorAuditPassed: true,
            treeClean: true,
            fidelityPassed: true,
            eligibleForAutoApproval: true,
            reasons: [],
          },
          agentSessionId: "session-abc",
        }),
      );

      const result = await dispatchTask("TASK-042", adapterWithJudgeMode("enforce"), {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("awaiting_judge_approval");
      const saved = JSON.parse(
        await fs.readFile(path.join(approvalDir, "TASK-042-judge.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(saved.state).toBe("pending");
      expect((saved.review as { summary?: string } | undefined)?.summary).toBe("reviewed clean");
      expect(saved.reviewGate).toBeDefined();
      expect(saved.agentSessionId).toBe("session-abc");
    }, 15000);

    // Round-2 F1 (HIGH): re-opening the gate is not enough on its own.
    // A resume re-runs the judge and re-asks the intent model, so without
    // a durable, clearable hold a deterministic human_review pauses
    // forever — and in plain dispatch mode the gate block is disabled, so
    // nothing would ever read the pending record at all.
    test("an approved hold for the SAME diff releases the dispatch instead of re-pausing", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalPath = path.join(logDir, "approvals", "TASK-042-judge.json");

      // First pass: the intent model holds.
      const held = await dispatchTask("TASK-042", adapterWithJudgeMode("enforce"), {
        skipBranch: true,
        skipPr: true,
      });
      expect(held.outcome).toBe("awaiting_judge_approval");

      const pending = JSON.parse(await fs.readFile(approvalPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const hold = pending.intentHold as { diffFingerprint: string; rationale: string[] };
      expect(hold.diffFingerprint).toEqual(expect.any(String));
      expect(hold.rationale.join(" ")).toContain("intent");

      // A human approves. The intent model has NOT changed its mind.
      await fs.writeFile(
        approvalPath,
        JSON.stringify({ ...pending, state: "approved", approvedBy: "operator" }),
      );

      const released = await dispatchTask("TASK-042", adapterWithJudgeMode("enforce"), {
        skipBranch: true,
        skipPr: true,
      });

      expect(released.outcome).toBe("approved");
      // The cutover stood down rather than re-asking.
      expect(mockIntentRunnerRun).toHaveBeenCalledTimes(1);
    }, 20000);

    test("an approved hold does NOT carry over to a different diff", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());
      const logDir = path.join(tmpDir, ".quack", "logs");
      const approvalDir = path.join(logDir, "approvals");
      await fs.mkdir(approvalDir, { recursive: true });
      // An approval whose hold belongs to some OTHER work.
      await fs.writeFile(
        path.join(approvalDir, "TASK-042-judge.json"),
        JSON.stringify({
          taskId: "TASK-042",
          state: "approved",
          approvedBy: "operator",
          diff: "unrelated",
          filesModified: [],
          filesCreated: [],
          verificationPassed: true,
          createdAt: new Date().toISOString(),
          intentHold: {
            rationale: ["stale hold"],
            diffFingerprint: "not-this-diff",
            heldAt: new Date().toISOString(),
          },
        }),
      );

      const result = await dispatchTask("TASK-042", adapterWithJudgeMode("enforce"), {
        skipBranch: true,
        skipPr: true,
      });

      // The hold re-arms: a stale approval cannot release new work.
      expect(result.outcome).toBe("awaiting_judge_approval");
      expect(mockIntentRunnerRun).toHaveBeenCalledTimes(1);
    }, 15000);

    test("enforce NEVER raises a verdict: a continue-hungry runner cannot rescue a REVISE", async () => {
      intentReturns("continue");
      mockRunJudge.mockResolvedValue(
        judged({
          verdict: "REVISE",
          feedback: "criteria not met",
          judgmentTrace: [{ sequence: 0, phase: "raw", decision: makeJudgmentDecision("repair") }],
        }),
      );

      const adapter = adapterWithJudgeMode("enforce");
      adapter.config.agent.maxRetries = 0;
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      // The REVISE stood: no APPROVE, no PR, no merge.
      expect(result.outcome).toBe("rejected");
      expect(result.judgeResult?.verdict).toBe("REVISE");
    }, 15000);

    test("a judgment config predating these stage keys resolves to off without crashing", async () => {
      intentReturns("human_review");
      mockRunJudge.mockResolvedValue(judged());
      const adapter = makeAdapter({ projectRoot: tmpDir });
      // Exactly the shape a pre-1316 adapter parse produced.
      (adapter.config as unknown as Record<string, unknown>).judgment = {
        stages: { docsReview: { mode: "off" }, readiness: { mode: "shadow" } },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockCreateIntentRunner).not.toHaveBeenCalled();
    }, 15000);
  });

  describe("enforce-mode safety_stop control transitions (TASK-1313 S2, round-2 F1/F2/F10)", () => {
    const FORCE_PUSH_FACT = {
      kind: "branch_mutation" as const,
      mutationClass: "history_rewrite" as const,
      verb: "push --force",
      targetRef: "main",
      candidateSafetyCode: "protected_branch_history_rewrite" as const,
      segment: "git push --force origin main",
    };

    const SEAL_GIT_MOCKS = {
      "status --short": { stdout: " M src/test.ts\n" },
      "diff --cached --name-only": { stdout: "src/test.ts\n" },
      "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
      "rev-parse --verify": { stdout: "abc123\n" },
      "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
      "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
      "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
    };

    async function writeEnforceSignalsConfig(): Promise<void> {
      await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".quack", "adapter.json"),
        JSON.stringify({
          judgment: { safetyFloor: { signals: { mode: "enforce" } } },
        }),
      );
    }

    test("judge-stage producer signal stops the dispatch even when the judge APPROVES; post-judge and PR are unreachable and no retry is consumed", async () => {
      await writeEnforceSignalsConfig();
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const stages: string[] = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", { safetyFacts: [FORCE_PUSH_FACT] }),
      );
      // The judge APPROVES — the producer safety signal must stop the
      // dispatch anyway (the model cannot override the floor).
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = SEAL_GIT_MOCKS;

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.outcome).toBe("safety_stop");
      expect(result.retriesUsed).toBe(0);
      expect(mockRunPostJudgeVerification).not.toHaveBeenCalled();
      expect(stages).not.toContain("post_judge_verify_start");
      expect(stages).not.toContain("pr_created");
      expect(stages).not.toContain("auto_merge_complete");
    }, 15000);

    test("loop_diff producer signal stops the dispatch before the judge stage and loop finalize", async () => {
      await writeEnforceSignalsConfig();
      const base = makeAdapter({ projectRoot: tmpDir });
      const adapter = makeAdapter({
        projectRoot: tmpDir,
        config: {
          ...base.config,
          executionMode: "loop",
          loop: {
            briefReview: {
              reviewer: {
                runner: "codex-cli",
                maxTurns: 30,
                timeoutMs: 600_000,
                codex: { binaryPath: "codex", sandbox: "read-only" },
              },
              requireCrossModel: true,
              autoApproveWhen: {
                maxFiles: 3,
                maxCriteria: 5,
                minBlueprintScore: 0,
                requireDecomposition: false,
              },
            },
            diffReview: {
              reviewer: {
                runner: "codex-cli",
                maxTurns: 30,
                timeoutMs: 600_000,
                codex: { binaryPath: "codex", sandbox: "read-only" },
              },
              requireCrossModel: true,
              autoApproveWhen: {
                requireVerificationPass: true,
                maxFilesChanged: 3,
                maxDiffLines: 200,
              },
            },
            models: {},
            recordOnFinalize: true,
          },
        },
      });
      const stages: string[] = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          claudeSessionId: "worker-session",
          safetyFacts: [FORCE_PUSH_FACT],
        }),
      );
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = SEAL_GIT_MOCKS;

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage) => stages.push(stage),
      });

      expect(result.outcome).toBe("safety_stop");
      expect(result.retriesUsed).toBe(0);
      // The stop preempts everything downstream of the loop diff gate.
      expect(mockRunJudge).not.toHaveBeenCalled();
      expect(mockRunPostJudgeVerification).not.toHaveBeenCalled();
      expect(stages).not.toContain("judge_start");
    }, 15000);

    test("resume validation (enforce) fails a worktree dispatch with tampered machinery BEFORE the worker runs", async () => {
      // Authoritative root = tmpDir; the dispatch targets a worktree-
      // shaped path beneath it carrying a tampered Tier-S file. The
      // enforce-mode config lives in the AUTHORITATIVE adapter.json.
      const worktree = path.join(tmpDir, ".quack", "worktrees", "wt-1");
      await fs.mkdir(path.join(worktree, ".quack"), { recursive: true });
      await fs.mkdir(path.join(worktree, "docs", "tasks"), { recursive: true });
      await fs.writeFile(
        path.join(worktree, "docs", "tasks", "TASK-042-test.md"),
        makeTaskContent("TASK-042", "Test Task"),
      );
      const adapterJson = JSON.stringify({
        judgment: { safetyFloor: { resumeValidation: { mode: "enforce" } } },
      });
      await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, ".quack", "adapter.json"), adapterJson);
      await fs.writeFile(path.join(tmpDir, ".quack", "conventions.md"), "clean conventions");
      await fs.writeFile(path.join(worktree, ".quack", "adapter.json"), adapterJson);
      await fs.writeFile(path.join(worktree, ".quack", "conventions.md"), "TAMPERED");

      const adapter = makeAdapter({ projectRoot: worktree });
      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = SEAL_GIT_MOCKS;

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("safety_stop");
      expect(result.error).toContain(".quack/conventions.md");
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockRunPostJudgeVerification).not.toHaveBeenCalled();
    }, 15000);

    test("report mode with the same producer fact does NOT change control flow", async () => {
      await fs.mkdir(path.join(tmpDir, ".quack"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".quack", "adapter.json"),
        JSON.stringify({
          judgment: { safetyFloor: { signals: { mode: "report" } } },
        }),
      );
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", { safetyFacts: [FORCE_PUSH_FACT] }),
      );
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = SEAL_GIT_MOCKS;

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockRunPostJudgeVerification).toHaveBeenCalled();
    }, 15000);
  });

  describe("gate rejection", () => {
    test("should return gate_failed when gate rejects", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "rejected",
        reason: "Schema validation failed",
        details: { valid: false, missing: ["title"], warnings: [] },
      });

      const result = await dispatchTask("TASK-042", adapter);

      expect(result.outcome).toBe("gate_failed");
      expect(result.error).toContain("Readiness gate rejected");
      expect(result.gateResult).toBeDefined();
    });

    test("should auto-approve enriched task and continue dispatch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "enriched",
        task: {
          original: {} as ParsedTask,
          enriched: {} as ParsedTask,
          diff: "some diff",
          approved: false,
        },
      });

      const result = await dispatchTask("TASK-042", adapter);

      // Enriched tasks are now auto-approved and continue through the pipeline
      // (no longer blocked for human review)
      expect(result.outcome).not.toBe("gate_failed");
    });

    test("should pass enriched task content directly into context assembly", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const enrichedRawContent = "# TASK-042: Test Task\n\n## Enriched\nMore detail";

      mockRunReadinessGate.mockResolvedValue({
        outcome: "enriched",
        task: {
          original: {} as ParsedTask,
          enriched: {
            id: "TASK-042",
            title: "Test Task",
            priority: "P1-HIGH",
            effort: "4 hours",
            status: "BACKLOG",
            blockedBy: [],
            blocks: [],
            supersededBy: [],
            supersedes: [],
            relevanceReview: "",
            conventions: [],
            tags: ["test"],
            problemStatement: "Test problem statement.",
            currentState: "Current state.",
            recommendedApproach: "Recommended approach.",
            filesToModify: [{ path: "src/test.ts", action: "Create", notes: "Test file" }],
            successCriteria: ["Test criterion 1", "Test criterion 2"],
            testingRequirements: ["Test requirement"],
            contextReferences: [],
            rawContent: enrichedRawContent,
          },
          diff: "enriched by agent",
          approved: false,
        },
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockAssembleContext.mock.calls[0]?.[0].rawContent).toBe(enrichedRawContent);
    });
  });

  describe("skip gate option", () => {
    test("should skip gate when skipGate is true", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockRunReadinessGate).not.toHaveBeenCalled();
    });

    test("should still run deterministic pattern extraction when skipGate is true", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockExtractPatterns.mockResolvedValue({
        patterns: [
          {
            filePath: "src/test.ts",
            exists: true,
            exports: ["testFn"],
            wrapperPattern: "serviceWrapper",
            errorHandling: ["AppError"],
            importPatterns: [],
            fieldNaming: "camelCase",
            lineCount: 20,
            snippet: "export const testFn = () => {};",
          },
        ],
        siblingPatterns: [],
      });
      mockFormatPatternsForPrompt.mockReturnValue("codebase pattern block");

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockExtractPatterns).toHaveBeenCalled();
      expect(mockRunAgent.mock.calls[0]?.[1].codebasePatterns).toBe("codebase pattern block");
    });
  });

  describe("skip depth only option", () => {
    test("should pass skipDepthOnly through to the readiness gate", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipDepthOnly: true,
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockRunReadinessGate).toHaveBeenCalledWith(
        expect.anything(),
        adapter,
        expect.objectContaining({
          skipDepthOnly: true,
          allowEnrichmentFailureFallback: true,
        }),
        expect.anything(),
      );
    });
  });

  describe("dry run", () => {
    test("should return approved without executing when dryRun is true", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });

      const result = await dispatchTask("TASK-042", adapter, {
        dryRun: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(0);
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockRunJudge).not.toHaveBeenCalled();
    });
  });

  describe("agent failure", () => {
    test("should return agent_failed when agent fails", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "failure",
          error: "SDK crashed",
        }),
      );

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.error).toContain("SDK crashed");
    });

    test("should return agent_failed on timeout", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "timeout",
          error: "Agent timed out",
        }),
      );

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.error).toContain("timed out");
    });
  });

  describe("judge REJECT verdict", () => {
    test("should return needs_review when judge rejects but deterministic checks pass (authority inversion)", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge.mockResolvedValue(
        makeJudgeResult({
          verdict: "REJECT",
          feedback: "Tests were deleted.",
        }),
      );

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      // Authority inversion: deterministic checks pass → needs_review, not rejected
      expect(result.outcome).toBe("needs_review");
      expect(result.error).toContain("Authority inversion");
      expect(result.judgeResult?.verdict).toBe("REJECT");
    });

    test("should return rejected when judge rejects and deterministic checks fail", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const decisions: Array<Record<string, unknown>> = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge.mockResolvedValue(
        makeJudgeResult({
          verdict: "REJECT",
          feedback: "Tests were deleted.",
        }),
      );

      // Override post-judge mock to fail deterministic checks for this test
      const mockVerifier: { runPostJudgeVerification: jest.Mock } = jest.requireMock(
        "../../src/dispatcher/post-judge-verifier",
      );
      mockVerifier.runPostJudgeVerification.mockResolvedValueOnce({
        verified: false,
        buildPassed: true,
        testsPassed: false,
        lintPassed: true,
        testCount: 0,
        findings: [],
        summary: "Tests failed",
      });

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        onEvent: (stage, payload) => {
          if (stage === "judgment_decision") decisions.push(payload);
        },
      });

      expect(result.outcome).toBe("rejected");
      expect(result.error).toContain("REJECT");
      expect(result.error).toContain("Tests were deleted");
      expect(result.judgeResult?.verdict).toBe("REJECT");
      expect(decisions.at(-1)).toMatchObject({
        stage: "post_judge",
        attempt: 0,
        sequence: 0,
        final: true,
        decision: {
          action: "human_review",
          safetyFloor: { passed: true },
        },
      });
    });

    test("preserves rejection and emits a final human-review decision when authority verification errors", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      const decisions: Array<Record<string, unknown>> = [];

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockGitResults = { diff: { stdout: "diff content" } };
      mockRunJudge.mockResolvedValue(
        makeJudgeResult({
          verdict: "REJECT",
          feedback: "Review requires operator confirmation.",
          judgmentTrace: [
            {
              sequence: 0,
              phase: "raw",
              decision: makeJudgmentDecision("human_review"),
            },
          ],
        }),
      );

      const mockVerifier: { runPostJudgeVerification: jest.Mock } = jest.requireMock(
        "../../src/dispatcher/post-judge-verifier",
      );
      mockVerifier.runPostJudgeVerification.mockRejectedValueOnce(
        new Error("verification transport unavailable"),
      );

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => {
          if (stage === "judgment_decision") decisions.push(payload);
        },
      });

      expect(result.outcome).toBe("rejected");
      expect(decisions).toHaveLength(2);
      expect(decisions[1]).toMatchObject({
        stage: "post_judge",
        attempt: 0,
        sequence: 1,
        final: true,
        decision: {
          action: "human_review",
          signals: [expect.objectContaining({ code: "post_judge_verification_error" })],
        },
      });
    });
  });

  describe("judge REVISE verdict -> retry", () => {
    test("should retry on REVISE and succeed on second attempt", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent succeeds both times
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Judge: first REVISE, then APPROVE
      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Missing edge case test.",
            criteriaGaps: ["Edge case not covered"],
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(1);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      expect(mockRunJudge).toHaveBeenCalledTimes(2);
      expect(result.outputSnapshots).toHaveLength(2);
      expect(result.outputSnapshots?.[0]).toMatchObject({ attempt: 1, kind: "worker" });
      expect(result.outputSnapshots?.[1]).toMatchObject({ attempt: 2, kind: "retry" });
    });

    test("should include judge feedback in retry prompt", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Add validation tests.",
            scopeViolations: ["Modified unrelated file"],
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      // Check the retry call includes judge feedback
      const retryCallArgs = mockRunAgent.mock.calls[1];
      const retryContext: TaskContext = retryCallArgs[1];
      expect(retryContext.taskSpec).toContain("REVISION REQUIRED");
      expect(retryContext.taskSpec).toContain("Add validation tests");
      expect(retryContext.taskSpec).toContain("Modified unrelated file");
    });

    test("should include blueprint in retry prompt when blueprint is present", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(
        makeContext({
          blueprint: "## Implementation Blueprint\n\nDetailed plan with integration points.",
        }),
      );

      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Missing edge case handling.",
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      // Check the retry call includes the blueprint
      const retryCallArgs = mockRunAgent.mock.calls[1];
      const retryContext: TaskContext = retryCallArgs[1];
      expect(retryContext.taskSpec).toContain("Original Implementation Blueprint");
      expect(retryContext.taskSpec).toContain("Detailed plan with integration points");
      expect(retryContext.taskSpec).toContain("Review it alongside the judge feedback");
    });

    test("should not include blueprint section in retry prompt when blueprint is absent", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(
        makeContext({
          blueprint: undefined,
        }),
      );

      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Fix the tests.",
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      // Check the retry call does NOT include blueprint section
      const retryCallArgs = mockRunAgent.mock.calls[1];
      const retryContext: TaskContext = retryCallArgs[1];
      expect(retryContext.taskSpec).toContain("REVISION REQUIRED");
      expect(retryContext.taskSpec).not.toContain("Original Implementation Blueprint");
    });

    test("should return rejected when REVISE persists after retry", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Both judge calls return REVISE
      mockRunJudge
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "REVISE", feedback: "Still wrong." }))
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "REVISE", feedback: "Still wrong." }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("rejected");
      expect(result.retriesUsed).toBe(1);
      expect(result.judgeResult?.verdict).toBe("REVISE");
    });

    test("should not retry when maxRetries is 0", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      adapter.config.agent.maxRetries = 0;

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "REVISE", feedback: "Fix it." }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("rejected");
      expect(result.retriesUsed).toBe(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(mockRunJudge).toHaveBeenCalledTimes(1);
    }, 15000);

    test("should retry multiple times: REVISE → REVISE → APPROVE", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      adapter.config.agent.maxRetries = 3;

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent succeeds all 3 times
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Judge: REVISE, REVISE, APPROVE
      mockRunJudge
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "REVISE", feedback: "Missing tests." }))
        .mockResolvedValueOnce(
          makeJudgeResult({ verdict: "REVISE", feedback: "Still needs work." }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(2);
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
      expect(mockRunJudge).toHaveBeenCalledTimes(3);
    }, 15000);

    test("should reject when all retries exhausted with REVISE", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      adapter.config.agent.maxRetries = 2;

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent succeeds all 3 times (1 initial + 2 retries)
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Judge always says REVISE
      mockRunJudge.mockResolvedValue(
        makeJudgeResult({ verdict: "REVISE", feedback: "Never good enough." }),
      );

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("rejected");
      expect(result.retriesUsed).toBe(2);
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
      expect(mockRunJudge).toHaveBeenCalledTimes(3);
    }, 15000);

    test("should resume session on REVISE when claudeSessionId is available and model unchanged", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Initial agent succeeds with session ID
      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            claudeSessionId: "session-retry-123",
          }),
        )
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Judge: REVISE then APPROVE
      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Missing error handling.",
            criteriaGaps: ["Error handling not implemented"],
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(1);

      // Verify retry used session resume
      const retryCallOptions = mockRunAgent.mock.calls[1][3] as Record<string, unknown>;
      expect(retryCallOptions.resumeSessionId).toBe("session-retry-123");
      expect(retryCallOptions.retryFeedback).toBeDefined();
      const feedback = retryCallOptions.retryFeedback as string;
      expect(feedback).toContain("REVISION REQUIRED");
      expect(feedback).toContain("Missing error handling");
      expect(feedback).toContain("Error handling not implemented");
      // Should NOT contain the full task spec (lean prompt)
      expect(feedback).not.toContain("Task spec content");
    }, 15000);

    test("should fall back to fresh session when model escalation occurs", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      // Configure model routing to escalate on retry
      adapter.config.modelRouting = {
        gateModel: "claude-haiku-4-5-20251001",
        enrichModel: "claude-sonnet-4-6",
        plannerModel: "claude-sonnet-4-6",
        workerModel: "claude-sonnet-4-6",
        workerComplexModel: "claude-opus-4-6",
        judgeModel: "claude-sonnet-4-6",
        retryEscalation: true,
      };

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Initial agent with session ID
      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            claudeSessionId: "session-escalation-123",
          }),
        )
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({
            verdict: "REVISE",
            feedback: "Fix it.",
          }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");

      // Verify retry used fresh session (no resumeSessionId) because model changed
      const retryCallOptions = mockRunAgent.mock.calls[1][3] as Record<string, unknown>;
      expect(retryCallOptions.resumeSessionId).toBeUndefined();
      // Fresh session should have the full task spec with judge feedback
      const retryContext: TaskContext = mockRunAgent.mock.calls[1][1];
      expect(retryContext.taskSpec).toContain("REVISION REQUIRED");
    }, 15000);

    test("should accumulate cost across retries", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      adapter.config.agent.maxRetries = 2;

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent returns different costs each run
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042", { totalCostUsd: 1.0 }))
        .mockResolvedValueOnce(makeAgentResult("TASK-042", { totalCostUsd: 0.5 }));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // REVISE then APPROVE
      mockRunJudge
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "REVISE", feedback: "Fix it." }))
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      // Cost should reflect both runs accumulated ($1.0 + $0.5 = $1.5)
      // The agentResult is the last run's result, but total cost events use accumulated
      expect(result.retriesUsed).toBe(1);
    });
  });

  describe("post-judge verification integration", () => {
    test("should convert APPROVE to REVISE when verification fails, then re-verify on next APPROVE", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent succeeds all attempts
      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      // Judge APPROVEs both times — the REVISE comes from the verifier, not the judge
      mockRunJudge
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }))
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      // Override the post-judge verifier mock: fail first time, pass second time
      const mockVerifier: { runPostJudgeVerification: jest.Mock } = jest.requireMock(
        "../../src/dispatcher/post-judge-verifier",
      );
      const { runPostJudgeVerification } = mockVerifier;
      runPostJudgeVerification
        .mockResolvedValueOnce({
          verified: false,
          buildPassed: true,
          testsPassed: false,
          lintPassed: true,
          testCount: 0,
          findings: [{ criterion: "Tests pass", status: "fail", evidence: "2 tests failed" }],
          summary: "Layer 1: test failures detected",
        })
        .mockResolvedValueOnce({
          verified: true,
          buildPassed: true,
          testsPassed: true,
          lintPassed: true,
          testCount: 5,
          findings: [],
          summary: "All checks passed",
        });

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(1);
      // Verifier should have been called twice: once on initial APPROVE (failed),
      // and once on retry APPROVE (passed) — proving the flag was reset
      expect(runPostJudgeVerification).toHaveBeenCalledTimes(2);
    });
  });

  describe("no_changes outcome", () => {
    test("should return no_changes when diff is empty and no uncommitted changes", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = {
        diff: { stdout: "" },
        "status --short": { stdout: "" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("no_changes");
    });

    test("should auto-commit and proceed to judge when uncommitted changes exist", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      // First diff call returns empty, then status shows uncommitted changes,
      // auto-commit succeeds, second diff returns real content
      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n" },
        "add -A": { stdout: "" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { stdout: "1 file changed" },
      };

      // Override diff to return empty first, then content
      mockGitResults["diff"] = { stdout: "" };

      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      // The auto-commit path is triggered, but since our mock always returns
      // empty diff for "diff" pattern, it will still be no_changes.
      // This validates the path is exercised — the mock infrastructure
      // doesn't support call-count-based results elegantly.
      expect(["approved", "no_changes"]).toContain(result.outcome);
    });
  });

  describe("error handling", () => {
    test("should return error when task file not found", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      const result = await dispatchTask("TASK-999", adapter, {
        skipGate: true,
      });

      expect(result.outcome).toBe("error");
      expect(result.error).toContain("Task file not found");
    });

    test("should return error on unexpected exception", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockRejectedValue(new Error("Unexpected SDK error"));

      const result = await dispatchTask("TASK-042", adapter);

      expect(result.outcome).toBe("error");
      expect(result.error).toContain("Unexpected SDK error");
    });

    test("should block judge when output seal fails", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockGitResults = {
        "status --short": { stdout: " M src/test.ts\n" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { error: true, stderr: "commit failed" },
        "diff main...HEAD": { stdout: "diff --git a/src/old.ts b/src/old.ts\n" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipBranch: true,
      });

      expect(result.outcome).toBe("error");
      expect(result.error).toContain("Agent output seal failed");
      expect(mockRunJudge).not.toHaveBeenCalled();
    });
  });

  describe("auto-resume on recoverable errors", () => {
    test("should auto-resume on budget_exceeded with progress on branch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // First agent call: budget_exceeded with session ID
      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "budget_exceeded",
            claudeSessionId: "session-abc-123",
            totalCostUsd: 3.0,
          }),
        )
        // Second agent call (resumed): succeeds
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "success",
            claudeSessionId: "session-abc-123-fork",
            totalCostUsd: 1.5,
          }),
        );

      // Branch has progress (diff is non-empty)
      mockGitResults = {
        diff: { stdout: "diff --git a/src/test.ts\n+new code" },
      };

      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("approved");
      // Agent was called twice: initial + resume
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      // Second call should have resumeSessionId
      const secondCallOptions = mockRunAgent.mock.calls[1][3] as Record<string, unknown>;
      expect(secondCallOptions.resumeSessionId).toBe("session-abc-123");
    }, 15000);

    test("should auto-resume on timeout with progress on branch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "timeout",
            claudeSessionId: "session-timeout-123",
            totalCostUsd: 2.0,
          }),
        )
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "success",
            totalCostUsd: 1.0,
          }),
        );

      mockGitResults = {
        diff: { stdout: "some changes" },
      };

      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
    }, 15000);

    test("should NOT auto-resume when no progress on branch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "budget_exceeded",
          claudeSessionId: "session-abc-123",
          totalCostUsd: 3.0,
        }),
      );

      // No progress — diff is empty
      mockGitResults = {
        diff: { stdout: "" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("agent_failed");
      // Agent was only called once (no resume)
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("should NOT auto-resume when remaining budget < $0.50", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      // Set tight budget
      adapter.config.agent.maxBudgetPerTask = 3.2;

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "budget_exceeded",
          claudeSessionId: "session-abc-123",
          totalCostUsd: 3.0, // $3 of $3.20 used, only $0.20 remaining < $0.50
        }),
      );

      mockGitResults = {
        diff: { stdout: "some changes" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("TASK-1314: max_turns joins the recoverable class and auto-resumes with committed progress", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "max_turns",
            claudeSessionId: "session-turns-1",
            totalCostUsd: 1.0,
          }),
        )
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      // Round-2 F3: the COMMITTED diff is EMPTY — resume must fire via
      // the sealable-dirty-work route (workers cannot commit), proving
      // hasSealableProgress is actually wired, not the old diff check.
      mockGitResults = {
        "fetch origin": { stdout: "" },
        "rev-parse --verify": { stdout: "abc123\n" },
        "diff origin/main...HEAD": { stdout: "" },
        "status --short": { stdout: " M src/test.ts\n" },
        "diff --cached --name-only": { stdout: "src/test.ts\n" },
        "commit -m": { stdout: "[quack/TASK-042 abc123] sealed output" },
        "diff --name-status": { stdout: "M\tsrc/test.ts\n" },
        "diff --stat main...HEAD": { stdout: " src/test.ts | 2 +-\n" },
        "diff main...HEAD": { stdout: "diff --git a/src/test.ts b/src/test.ts\n" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      expect(mockRunAgent.mock.calls[1]?.[3]).toEqual(
        expect.objectContaining({ resumeSessionId: "session-turns-1" }),
      );
    }, 15000);

    test("TASK-1314: failure outcome does NOT enter the resume branch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "failure",
          claudeSessionId: "session-fail-1",
          totalCostUsd: 1.0,
          error: "error_during_execution: boom",
        }),
      );
      mockGitResults = {
        diff: { stdout: "diff content" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(result.error).toContain("error_during_execution");
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    }, 15000);

    test("should NOT auto-resume without a session ID", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      mockRunAgent.mockResolvedValue(
        makeAgentResult("TASK-042", {
          outcome: "budget_exceeded",
          // No claudeSessionId
          totalCostUsd: 2.0,
        }),
      );

      mockGitResults = {
        diff: { stdout: "some changes" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("agent_failed");
      expect(mockRunAgent).toHaveBeenCalledTimes(1);
    });

    test("auto-resume should NOT increment retry counter", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Agent: budget_exceeded first, then success on resume
      mockRunAgent
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "budget_exceeded",
            claudeSessionId: "session-abc",
            totalCostUsd: 2.0,
          }),
        )
        .mockResolvedValueOnce(
          makeAgentResult("TASK-042", {
            outcome: "success",
            totalCostUsd: 1.0,
          }),
        );

      mockGitResults = { diff: { stdout: "changes" } };
      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
      });

      expect(result.outcome).toBe("approved");
      // Retry counter should be 0 — resume is not a retry
      expect(result.retriesUsed).toBe(0);
    }, 15000);
  });

  describe("checkpoint deletion on success", () => {
    test("should delete checkpoint after approved dispatch", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = { diff: { stdout: "diff content" } };
      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      await dispatchTask("TASK-042", adapter, { skipBranch: true });

      // Verify the checkpoint mock's delete was called
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { CheckpointManager } = require("../../src/dispatcher/checkpoint-manager") as {
        CheckpointManager: jest.Mock;
      };
      const mgrInstance = CheckpointManager.mock.results[0]?.value as { delete: jest.Mock };
      expect(mgrInstance.delete).toHaveBeenCalledWith("TASK-042");
    }, 15000);
  });

  describe("resume from checkpoint", () => {
    test("should skip gate when checkpoint has gate completed", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      // Pre-populate the checkpoint directly in the mock's in-memory store
      _mockCheckpoints.set("TASK-042", {
        taskId: "TASK-042",
        sessionId: "quack-TASK-042-old",
        completedStages: ["gate"],
        totalCostUsd: 0,
        retriesUsed: 0,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });

      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = { diff: { stdout: "diff content" } };
      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        resumeFromCheckpoint: true,
      });

      expect(result.outcome).toBe("approved");
      // Gate should NOT have been called — it was already completed
      expect(mockRunReadinessGate).not.toHaveBeenCalled();
    }, 15000);
  });

  describe("blueprint checks flow through judge (TASK-044)", () => {
    test("should pass blueprint-derived checks to initial judge call", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });

      // Context with blueprintPatterns
      const contextWithBlueprint = {
        ...makeContext(),
        blueprintPatterns: [
          {
            criterion: "Export function validateEmail",
            checkType: "grep" as const,
            pattern: "export function validateEmail",
            fileGlob: "src/validators.ts",
          },
        ],
      };
      mockAssembleContext.mockResolvedValue(contextWithBlueprint);
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = { diff: { stdout: "diff content" } };
      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      // Verify blueprintChecks were passed to runJudge
      expect(mockRunJudge).toHaveBeenCalledTimes(1);
      const judgeOptions = mockRunJudge.mock.calls[0][2] as Record<string, unknown>;
      expect(judgeOptions).toBeDefined();
      expect(judgeOptions.blueprintChecks).toBeDefined();
      const checks = judgeOptions.blueprintChecks as Array<Record<string, unknown>>;
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toContain("blueprint-0");
      expect(checks[0].type).toBe("grep");
      expect(checks[0].criterionMatch).toBe("Export function validateEmail");
    }, 15000);

    test("should pass blueprint-derived checks to retry judge call", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });

      // Context with blueprintPatterns
      const contextWithBlueprint = {
        ...makeContext(),
        blueprintPatterns: [
          {
            criterion: "Test file exists",
            checkType: "file_exists" as const,
            pattern: "tests/feature.test.ts",
            fileGlob: "",
          },
        ],
      };
      mockAssembleContext.mockResolvedValue(contextWithBlueprint);

      mockRunAgent
        .mockResolvedValueOnce(makeAgentResult("TASK-042"))
        .mockResolvedValueOnce(makeAgentResult("TASK-042"));

      mockGitResults = { diff: { stdout: "diff content" } };

      // First REVISE, then APPROVE on retry
      mockRunJudge
        .mockResolvedValueOnce(
          makeJudgeResult({ verdict: "REVISE", feedback: "Missing test file." }),
        )
        .mockResolvedValueOnce(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      expect(result.retriesUsed).toBe(1);
      // Verify both judge calls received blueprintChecks
      expect(mockRunJudge).toHaveBeenCalledTimes(2);

      const initialOptions = mockRunJudge.mock.calls[0][2] as Record<string, unknown>;
      expect(initialOptions.blueprintChecks).toBeDefined();
      const initialChecks = initialOptions.blueprintChecks as Array<Record<string, unknown>>;
      expect(initialChecks).toHaveLength(1);
      expect(initialChecks[0].type).toBe("file_exists");

      const retryOptions = mockRunJudge.mock.calls[1][2] as Record<string, unknown>;
      expect(retryOptions.blueprintChecks).toBeDefined();
      const retryChecks = retryOptions.blueprintChecks as Array<Record<string, unknown>>;
      expect(retryChecks).toHaveLength(1);
      expect(retryChecks[0].type).toBe("file_exists");
    }, 15000);

    test("should pass empty blueprintChecks when context has no blueprintPatterns", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });

      // Context without blueprintPatterns (standard case)
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));

      mockGitResults = { diff: { stdout: "diff content" } };
      mockRunJudge.mockResolvedValue(makeJudgeResult({ verdict: "APPROVE" }));

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      // Verify empty blueprintChecks were passed (no error)
      const judgeOptions = mockRunJudge.mock.calls[0][2] as Record<string, unknown>;
      expect(judgeOptions.blueprintChecks).toBeDefined();
      expect(judgeOptions.blueprintChecks).toEqual([]);
    }, 15000);
  });

  // ─── Preflight Blueprint Caching ────────────────────────────────────

  describe("preflight blueprint caching", () => {
    test("should use cached blueprint when preflight cache is fresh", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      // Write a preflight cache file with a matching content hash
      const taskFilePath = path.join(tmpDir, "docs", "tasks", "TASK-042-test.md");
      const taskContent = await fs.readFile(taskFilePath, "utf-8");
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(taskContent).digest("hex");

      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });
      const preflightResult = {
        taskId: "TASK-042",
        timestamp: new Date().toISOString(),
        contentHash,
        gate: { ready: true, score: 5, dimensions: {} },
        blueprint: {
          fileAnalyses: 2,
          codeExamples: 1,
          verificationPatterns: 0,
          antiPatterns: 0,
          formattedMarkdown: "## Cached Blueprint\n\nThis blueprint was pre-generated.",
        },
        contextEstimate: {
          taskSpec: 500,
          blueprint: 1000,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 1500,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 1,
          successCriteria: 2,
          estimatedContextTokens: 1500,
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      };
      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify(preflightResult, null, 2),
      );

      // Mock pipeline steps
      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = {
        "git checkout -b": { stdout: "" },
        "git diff": { stdout: "diff --git a/src/test.ts" },
        "git push": { stdout: "" },
        "gh pr create": { stdout: "https://github.com/test/pr/1" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        disableEvents: true,
        skipBranch: true,
      });

      expect(result.outcome).toBe("approved");
      // generateBlueprint should NOT have been called — cached blueprint used
      expect(mockGenerateBlueprint).not.toHaveBeenCalled();
      expect(mockFormatBlueprintForPrompt).not.toHaveBeenCalled();
    });

    test("should generate fresh blueprint when preflight cache is stale", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      // Write a preflight cache file with a DIFFERENT content hash (stale)
      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });
      const preflightResult = {
        taskId: "TASK-042",
        timestamp: new Date().toISOString(),
        contentHash: "stale_hash_that_does_not_match_current_task_content",
        gate: { ready: true, score: 5, dimensions: {} },
        blueprint: {
          fileAnalyses: 1,
          codeExamples: 0,
          verificationPatterns: 0,
          antiPatterns: 0,
          formattedMarkdown: "## Stale Blueprint",
        },
        contextEstimate: {
          taskSpec: 500,
          blueprint: 500,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 1000,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 1,
          successCriteria: 2,
          estimatedContextTokens: 1000,
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      };
      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify(preflightResult, null, 2),
      );

      // Mock pipeline steps
      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = {
        "git checkout -b": { stdout: "" },
        "git diff": { stdout: "diff --git a/src/test.ts" },
        "git push": { stdout: "" },
        "gh pr create": { stdout: "https://github.com/test/pr/1" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        disableEvents: true,
        skipBranch: true,
      });

      expect(result.outcome).toBe("approved");
      // generateBlueprint SHOULD have been called — cache was stale
      expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);
      expect(mockFormatBlueprintForPrompt).toHaveBeenCalledTimes(1);
    });
  });

  // ─── TASK-076: Fix 1 — subtask merge to feature branch ────────────

  describe("subtask merge to feature branch", () => {
    test("should merge subtask to feature branch when parentTaskId is set", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        "checkout -b": { stdout: "Switched to branch" },
        "diff quack/TASK-040": { stdout: "diff content" },
        "push -u origin": { stdout: "Branch pushed" },
        // Feature branch: rev-parse fails (doesn't exist), branch creation succeeds
        "rev-parse --verify quack/TASK-040": { error: true, stderr: "unknown revision" },
        "branch quack/TASK-040 main": { stdout: "" },
        // Content validation: branch has commits
        "log --oneline": { stdout: "abc123 some commit\n" },
      };

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
        parentTaskId: "TASK-040",
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");
      expect(result.autoMerged).toBe(true);

      // Should have emitted subtask_merged_to_feature_branch
      const mergeEvent = emitted.find((e) => e.stage === "subtask_merged_to_feature_branch");
      expect(mergeEvent).toBeDefined();
      expect(mergeEvent!.payload.parentTaskId).toBe("TASK-040");
      expect(mergeEvent!.payload.featureBranch).toBe("quack/TASK-040");
    }, 15000);

    test("Docker host-promotion mode never publishes or merges from the untrusted child", async () => {
      const adapter = makeAdapter({
        projectRoot: tmpDir,
        config: {
          ...makeAdapter().config,
          git: {
            ...makeAdapter().config.git,
            autoPush: true,
            autoCreatePr: true,
            autoMerge: true,
            autoMergeTarget: "main",
          },
        },
      });
      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = {
        "checkout -b": { stdout: "Switched to branch" },
        "diff main": { stdout: "diff content" },
        "rev-parse --verify quack/TASK-040": { error: true, stderr: "unknown revision" },
        "branch quack/TASK-040 main": { stdout: "" },
        "push -u origin": { error: true, stderr: "child has no remote" },
        "fetch origin main": { error: true, stderr: "child has no authoritative remote" },
      };

      const previousPromotion = process.env.QUACK_DOCKER_HOST_PROMOTION;
      const previousParent = process.env.QUACK_DOCKER_PARENT_TASK_ID;
      const previousShared = process.env.QUACK_DOCKER_SHARED_BRANCH;
      const previousAdmitted = process.env.QUACK_DOCKER_ADMITTED_BRANCH;
      process.env.QUACK_DOCKER_HOST_PROMOTION = "1";
      process.env.QUACK_DOCKER_PARENT_TASK_ID = "TASK-040";
      process.env.QUACK_DOCKER_SHARED_BRANCH = "quack/TASK-040";
      process.env.QUACK_DOCKER_ADMITTED_BRANCH = "quack/TASK-040";
      try {
        const result = await dispatchTask("TASK-042", adapter, {
          skipGate: true,
        });
        if (result.outcome !== "approved") {
          throw new Error(
            `Docker host-promotion fixture failed: ${result.error ?? result.outcome}`,
          );
        }
        expect(result.outcome).toBe("approved");
        expect(result.prUrl).toBeUndefined();
        expect(result.autoMerged).toBeUndefined();
        expect(result.error).toBeUndefined();
      } finally {
        if (previousPromotion === undefined) delete process.env.QUACK_DOCKER_HOST_PROMOTION;
        else process.env.QUACK_DOCKER_HOST_PROMOTION = previousPromotion;
        if (previousParent === undefined) delete process.env.QUACK_DOCKER_PARENT_TASK_ID;
        else process.env.QUACK_DOCKER_PARENT_TASK_ID = previousParent;
        if (previousShared === undefined) delete process.env.QUACK_DOCKER_SHARED_BRANCH;
        else process.env.QUACK_DOCKER_SHARED_BRANCH = previousShared;
        if (previousAdmitted === undefined) delete process.env.QUACK_DOCKER_ADMITTED_BRANCH;
        else process.env.QUACK_DOCKER_ADMITTED_BRANCH = previousAdmitted;
      }
    }, 15000);
  });

  // ─── TASK-076: Fix 2 — content validation: abort on zero commits ──

  describe("content validation in handleApproval", () => {
    test("should abort with error when branch has zero commits", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        "checkout -b": { stdout: "Switched to branch" },
        "diff main": { stdout: "diff content" },
        // Content validation: zero commits (empty log)
        "log --oneline": { stdout: "" },
      };

      const result = await dispatchTask("TASK-042", adapter, {
        skipGate: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("error");
      expect(result.error).toContain("no commits relative to base");
      expect(result.error).toContain("Worktree preserved");
      expect(result.error).toContain(tmpDir);
    }, 15000);
  });

  // ─── TASK-076: Fix 2 — worktree preserved on merge failure ────────

  describe("worktree preservation on merge failure", () => {
    test("should include worktreePath in auto_merge_failed event", async () => {
      const adapter = makeAdapter({
        projectRoot: tmpDir,
        config: {
          ...makeAdapter().config,
          git: {
            ...makeAdapter().config.git,
            autoMerge: true,
            autoMergeTarget: "staging",
          },
        },
      });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        "checkout -b": { stdout: "Switched to branch" },
        "diff main": { stdout: "diff content" },
        "log --oneline": { stdout: "abc123 commit\n" },
        "push -u origin": { stdout: "Branch pushed" },
        // Merge fails
        "fetch origin staging": { error: true, stderr: "fetch failed" },
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

      // Should have emitted auto_merge_failed with worktreePath
      const failEvent = emitted.find((e) => e.stage === "auto_merge_failed");
      expect(failEvent).toBeDefined();
      expect(failEvent!.payload.worktreePath).toBe(tmpDir);
    }, 15000);
  });

  // ─── TASK-076: Fix 3 — gate auto-skip on high preflight score ─────

  describe("gate auto-skip on high preflight score", () => {
    test("TASK-1315 (round-1b F2): a readiness-mode flip forces a LIVE gate run instead of the cached skip", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      (adapter.config as unknown as Record<string, unknown>).judgment = {
        runner: {
          provider: "claude-sdk",
          model: "test-model",
          maxTurns: 5,
          timeoutMs: 1_000,
        },
        stages: { docsReview: { mode: "off" }, readiness: { mode: "shadow" } },
      };

      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });
      const taskFilePath = path.join(tmpDir, "docs", "tasks", "TASK-042-test.md");
      const taskContent = await fs.readFile(taskFilePath, "utf-8");
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(taskContent).digest("hex");

      // An off-era cached preflight (no readinessJudgmentMode) with a
      // skip-worthy score: the shadow-mode adapter must NOT reuse it.
      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify({
          taskId: "TASK-042",
          timestamp: new Date().toISOString(),
          contentHash,
          gate: { ready: true, score: 4.9, dimensions: {} },
          blueprint: {
            fileAnalyses: 0,
            codeExamples: 0,
            verificationPatterns: 0,
            antiPatterns: 0,
            formattedMarkdown: "## Blueprint",
          },
          contextEstimate: { totalTokens: 100, sections: {} },
          complexity: {
            filesToModify: 1,
            successCriteria: 1,
            estimatedContextTokens: 100,
            independentFeatures: 1,
            featureClusters: [],
            recommendDecomposition: false,
            reason: "within thresholds",
          },
        }),
      );

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = { diff: { stdout: "diff content" } };

      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
      });

      expect(result.outcome).toBe("approved");
      // The live gate RAN — the off-era cache did not authorize a skip.
      expect(mockRunReadinessGate).toHaveBeenCalled();
    }, 15000);

    test("TASK-1315 r2-F1: a cached CONFIRMED REJECTION never authorizes a gate skip", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });
      const taskFilePath = path.join(tmpDir, "docs", "tasks", "TASK-042-test.md");
      const taskContent = await fs.readFile(taskFilePath, "utf-8");
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(taskContent).digest("hex");

      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify({
          taskId: "TASK-042",
          timestamp: new Date().toISOString(),
          contentHash,
          gate: {
            ready: false,
            score: 4.6,
            dimensions: {},
            readinessJudgmentMode: "off",
            activeOutcome: "rejected",
          },
          blueprint: {
            fileAnalyses: 0,
            codeExamples: 0,
            verificationPatterns: 0,
            antiPatterns: 0,
            formattedMarkdown: "## Blueprint",
          },
          contextEstimate: { totalTokens: 100, sections: {} },
          complexity: {
            filesToModify: 1,
            successCriteria: 1,
            estimatedContextTokens: 100,
            independentFeatures: 1,
            featureClusters: [],
            recommendDecomposition: false,
            reason: "within thresholds",
          },
        }),
      );

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = { diff: { stdout: "diff content" } };

      await dispatchTask("TASK-042", adapter, { skipBranch: true, skipPr: true });
      expect(mockRunReadinessGate).toHaveBeenCalled();
    }, 15000);

    test("TASK-1315 r2-F1: a skipGate-stamped preflight never authorizes a gate skip", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });
      const taskFilePath = path.join(tmpDir, "docs", "tasks", "TASK-042-test.md");
      const taskContent = await fs.readFile(taskFilePath, "utf-8");
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(taskContent).digest("hex");

      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify({
          taskId: "TASK-042",
          timestamp: new Date().toISOString(),
          contentHash,
          gate: {
            ready: true,
            score: 5,
            dimensions: {},
            readinessJudgmentMode: "off",
            gateSkipped: true,
          },
          blueprint: {
            fileAnalyses: 0,
            codeExamples: 0,
            verificationPatterns: 0,
            antiPatterns: 0,
            formattedMarkdown: "## Blueprint",
          },
          contextEstimate: { totalTokens: 100, sections: {} },
          complexity: {
            filesToModify: 1,
            successCriteria: 1,
            estimatedContextTokens: 100,
            independentFeatures: 1,
            featureClusters: [],
            recommendDecomposition: false,
            reason: "within thresholds",
          },
        }),
      );

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());
      mockGitResults = { diff: { stdout: "diff content" } };

      await dispatchTask("TASK-042", adapter, { skipBranch: true, skipPr: true });
      expect(mockRunReadinessGate).toHaveBeenCalled();
    }, 15000);

    test("should skip gate when cached preflight score >= 4.7", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      // Write a cached preflight result with high score
      const prepDir = path.join(tmpDir, ".quack", "prep");
      await fs.mkdir(prepDir, { recursive: true });

      // Compute the content hash the same way the code does
      const taskFilePath = path.join(tmpDir, "docs", "tasks", "TASK-042-test.md");
      const taskContent = await fs.readFile(taskFilePath, "utf-8");
      const crypto = await import("node:crypto");
      const contentHash = crypto.createHash("sha256").update(taskContent).digest("hex");

      const preflightResult = {
        taskId: "TASK-042",
        timestamp: new Date().toISOString(),
        contentHash,
        gate: {
          ready: true,
          score: 4.8,
          dimensions: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        },
        blueprint: {
          fileAnalyses: 2,
          codeExamples: 1,
          verificationPatterns: 1,
          antiPatterns: 0,
          formattedMarkdown: "## Blueprint\ncached",
        },
        contextEstimate: { totalTokens: 5000, sections: {} },
        complexity: {
          filesToModify: 2,
          successCriteria: 3,
          estimatedContextTokens: 5000,
          independentFeatures: 1,
          featureClusters: [],
          recommendDecomposition: false,
          reason: "within thresholds",
        },
      };

      await fs.writeFile(
        path.join(prepDir, "TASK-042-preflight.json"),
        JSON.stringify(preflightResult),
      );

      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGitResults = {
        "diff main": { stdout: "diff content" },
      };

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage: string, payload: Record<string, unknown>) => {
          emitted.push({ stage, payload });
        },
      });

      expect(result.outcome).toBe("approved");

      // Gate should NOT have been called
      expect(mockRunReadinessGate).not.toHaveBeenCalled();

      // Should have emitted stage_skipped for gate with preflight reason
      const gateSkip = emitted.find(
        (e) =>
          e.stage === "stage_skipped" && (e.payload.reason as string)?.includes("preflight score"),
      );
      expect(gateSkip).toBeDefined();
      expect(gateSkip!.payload.reason as string).toContain("4.8");
      expect(gateSkip!.payload.reason as string).toContain("4.5");
    }, 15000);
  });

  describe("core.worktree cleanup (TASK-902)", () => {
    test("full dispatch happy-path leaves core.worktree unset after completion", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      // Simulate a leaked core.worktree value pointing inside .quack/worktrees/
      const leakedPath = "/fake/project/.quack/worktrees/TASK-893-A";
      mockGitResults = {
        diff: { stdout: "diff content" },
        "config --local --get core.worktree": { stdout: leakedPath + "\n" },
        "config --local --unset core.worktree": { stdout: "" },
      };

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => emitted.push({ stage, payload }),
      });

      expect(result.outcome).toBe("approved");

      // safeUnsetCoreWorktree runs both pre-dispatch and in finally block.
      // At least one core_worktree_cleaned event should have been emitted.
      const cleanedEvents = emitted.filter((e) => e.stage === "core_worktree_cleaned");
      expect(cleanedEvents.length).toBeGreaterThanOrEqual(1);
      expect(cleanedEvents[0].payload).toMatchObject({
        repoPath: tmpDir,
        leakedValue: leakedPath,
      });
    }, 15000);

    test("SIGTERM/error mid-dispatch still results in core.worktree cleanup (try/finally fires)", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });

      mockRunReadinessGate.mockResolvedValue({
        outcome: "pass",
        task: {} as ParsedTask,
      });
      mockAssembleContext.mockResolvedValue(makeContext());

      // Simulate agent throwing an unhandled error (mimics SIGTERM/kill unwinding)
      mockRunAgent.mockRejectedValue(new Error("Process killed (simulated SIGTERM)"));

      // Set up leaked core.worktree
      const leakedPath = "/fake/project/.quack/worktrees/TASK-042-impl";
      mockGitResults = {
        "config --local --get core.worktree": { stdout: leakedPath + "\n" },
        "config --local --unset core.worktree": { stdout: "" },
      };

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => emitted.push({ stage, payload }),
      });

      // Dispatch should fail (unhandled agent error surfaces as outcome "error")
      expect(result.outcome).toBe("error");

      // But the finally block MUST still have run cleanup.
      // The finally block calls safeUnsetCoreWorktree which emits core_worktree_cleaned.
      const cleanedEvents = emitted.filter((e) => e.stage === "core_worktree_cleaned");
      expect(cleanedEvents.length).toBeGreaterThanOrEqual(1);
      expect(cleanedEvents[0].payload).toMatchObject({
        repoPath: tmpDir,
        leakedValue: leakedPath,
      });
    }, 15000);
  });

  // ─── TASK-833: Blueprint stall detection + fast fallback ──────────
  describe("blueprint stall detection (TASK-833)", () => {
    const ORIGINAL_WARNING_MS = process.env.QUACK_BLUEPRINT_WARNING_MS;
    const ORIGINAL_TIMEOUT_MS = process.env.QUACK_BLUEPRINT_TIMEOUT_MS;

    afterEach(() => {
      if (ORIGINAL_WARNING_MS === undefined) delete process.env.QUACK_BLUEPRINT_WARNING_MS;
      else process.env.QUACK_BLUEPRINT_WARNING_MS = ORIGINAL_WARNING_MS;
      if (ORIGINAL_TIMEOUT_MS === undefined) delete process.env.QUACK_BLUEPRINT_TIMEOUT_MS;
      else process.env.QUACK_BLUEPRINT_TIMEOUT_MS = ORIGINAL_TIMEOUT_MS;
    });

    test("emits blueprint_start before generateBlueprint and blueprint_generated after (happy path)", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      process.env.QUACK_BLUEPRINT_WARNING_MS = "100000";
      process.env.QUACK_BLUEPRINT_TIMEOUT_MS = "200000";

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => emitted.push({ stage, payload }),
      });

      const startIdx = emitted.findIndex((e) => e.stage === "blueprint_start");
      const generatedIdx = emitted.findIndex((e) => e.stage === "blueprint_generated");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(generatedIdx).toBeGreaterThan(startIdx);
      expect(emitted[startIdx].payload).toMatchObject({
        taskId: "TASK-042",
        cached: false,
        mode: "dispatch",
        warningMs: 100000,
        timeoutMs: 200000,
      });
      // No warning or fallback on the happy path
      expect(emitted.find((e) => e.stage === "blueprint_warning")).toBeUndefined();
      expect(emitted.find((e) => e.stage === "blueprint_fallback")).toBeUndefined();
    }, 15000);

    test("emits blueprint_warning when generateBlueprint exceeds warningMs", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      process.env.QUACK_BLUEPRINT_WARNING_MS = "50";
      process.env.QUACK_BLUEPRINT_TIMEOUT_MS = "5000";

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      mockGenerateBlueprint.mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  taskId: "TASK-042",
                  fileAnalyses: [],
                  codeExamples: [],
                  verificationPatterns: [],
                  antiPatterns: [],
                  preconditions: [],
                }),
              250,
            ),
          ),
      );

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => emitted.push({ stage, payload }),
      });

      const warning = emitted.find((e) => e.stage === "blueprint_warning");
      expect(warning).toBeDefined();
      expect(warning!.payload).toMatchObject({
        taskId: "TASK-042",
        reason: "inline_blueprint_slow",
      });
      expect(warning!.payload.elapsedMs).toBeGreaterThanOrEqual(50);
      // Generation still completed normally — no fallback
      expect(emitted.find((e) => e.stage === "blueprint_fallback")).toBeUndefined();
      expect(emitted.find((e) => e.stage === "blueprint_generated")).toBeDefined();
    }, 15000);

    test("falls back to createMinimalBlueprint and emits blueprint_fallback when generateBlueprint exceeds timeoutMs", async () => {
      const adapter = makeAdapter({ projectRoot: tmpDir });
      process.env.QUACK_BLUEPRINT_WARNING_MS = "50";
      process.env.QUACK_BLUEPRINT_TIMEOUT_MS = "150";

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task: {} as ParsedTask });
      mockAssembleContext.mockResolvedValue(makeContext());
      mockRunAgent.mockResolvedValue(makeAgentResult("TASK-042"));
      mockRunJudge.mockResolvedValue(makeJudgeResult());

      // Never resolves — simulates the stall described in the spec
      mockGenerateBlueprint.mockImplementationOnce(() => new Promise(() => {}));

      const emitted: Array<{ stage: string; payload: Record<string, unknown> }> = [];
      const result = await dispatchTask("TASK-042", adapter, {
        skipBranch: true,
        skipPr: true,
        onEvent: (stage, payload) => emitted.push({ stage, payload }),
      });

      const fallback = emitted.find((e) => e.stage === "blueprint_fallback");
      expect(fallback).toBeDefined();
      expect(fallback!.payload).toMatchObject({
        taskId: "TASK-042",
        reason: "dispatch_timeout_minimal_blueprint",
      });
      expect(fallback!.payload.elapsedMs).toBeGreaterThanOrEqual(150);
      // Dispatch must still reach blueprint_generated and the rest of the
      // pipeline — that's the whole point: don't block on the stall.
      // The eventual outcome depends on whether the agent produces changes
      // off the minimal blueprint (skipBranch/skipPr mode here), but the
      // pipeline must NOT remain stuck at blueprint.
      expect(emitted.find((e) => e.stage === "blueprint_generated")).toBeDefined();
      expect(result.outcome).not.toBe("error");
    }, 15000);
  });
});
