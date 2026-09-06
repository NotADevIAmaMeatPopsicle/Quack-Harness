// Batch-path coverage for the enforcement verdict constraints (TASK-1200).
// Split from llm-judge.test.ts because this file mocks BatchClient at the
// module level (jest monolith anti-pattern: split by mock dependency).

import { batchJudge } from "../../src/judge/llm-judge";
import type { JudgeInput } from "../../src/judge/llm-judge";
import type { AdapterConfig, VerificationResult } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

// The instance closure is lazy (runs when batchJudge constructs BatchClient
// inside a test), so referencing the mock-prefixed const is TDZ-safe.
const mockSubmitAndWait = jest.fn();

jest.mock("../../src/core/batch-client", () => ({
  __esModule: true,
  BatchClient: jest.fn(() => ({ submitAndWait: mockSubmitAndWait })),
  DEFAULT_BATCH_CONFIG: {
    enabled: false,
    minBatchSize: 2,
    maxWaitSeconds: 30,
    pollIntervalMs: 5000,
    timeoutMs: 300000,
  },
}));

function makeVerificationResult(): VerificationResult {
  return { allPassed: true, commands: [], conventionChecks: [] };
}

function makeJudgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    taskSpec: "# TASK-042: Planner\n\n## Success Criteria\n- [ ] Enforces maxTasks limit of 5",
    gitDiff: "diff --git a/src/planner.ts b/src/planner.ts\n+const tasks = plan();",
    verificationResults: makeVerificationResult(),
    ...overrides,
  };
}

function makeAdapter(): ProjectAdapter {
  const config: AdapterConfig = {
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
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
  };

  return {
    config,
    projectRoot: "/fake/project/root",
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("batchJudge enforcement constraints (TASK-1200)", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  beforeEach(() => {
    mockSubmitAndWait.mockReset();
  });

  test("a batch item parsed as APPROVE with an llm_instruction_only PASS comes back REVISE", async () => {
    const approveWithLoophole = {
      verdict: "APPROVE",
      confidence: 0.9,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "Complete.",
      criteria_evaluation: [
        {
          criterion: "Enforces maxTasks limit of 5",
          status: "PASS",
          evidence: "src/planner-prompt.ts:46",
          reasoning: "The prompt caps the count",
          enforcement_type: "llm_instruction_only",
        },
      ],
    };

    mockSubmitAndWait.mockResolvedValue([
      {
        id: "judge-0",
        status: "success",
        response: JSON.stringify(approveWithLoophole),
      },
    ]);

    const results = await batchJudge([makeJudgeInput()], makeAdapter(), undefined, {
      enabled: true,
      minBatchSize: 1,
      maxWaitSeconds: 1,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    const result = results.get("judge-0");
    expect(result).toBeDefined();
    expect(result!.verdict).toBe("REVISE");
    expect(result!.feedback.startsWith("[ENFORCEMENT OVERRIDE]")).toBe(true);
    expect(result!.enforcementDemotions).toHaveLength(1);
    expect(result!.criteriaEvaluation![0].status).toBe("PARTIAL");
  });

  test("a batch item with deterministic_code PASS stays APPROVE (control)", async () => {
    const cleanApprove = {
      verdict: "APPROVE",
      confidence: 0.92,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "Complete.",
      criteria_evaluation: [
        {
          criterion: "Enforces maxTasks limit of 5",
          status: "PASS",
          evidence: "src/planner.ts:46",
          reasoning: "slice(0, maxTasks) applied to the result",
          enforcement_type: "deterministic_code",
        },
      ],
    };

    mockSubmitAndWait.mockResolvedValue([
      {
        id: "judge-0",
        status: "success",
        response: JSON.stringify(cleanApprove),
      },
    ]);

    const results = await batchJudge([makeJudgeInput()], makeAdapter(), undefined, {
      enabled: true,
      minBatchSize: 1,
      maxWaitSeconds: 1,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    const result = results.get("judge-0");
    expect(result).toBeDefined();
    expect(result!.verdict).toBe("APPROVE");
    expect(result!.enforcementDemotions).toBeUndefined();
  });
});
