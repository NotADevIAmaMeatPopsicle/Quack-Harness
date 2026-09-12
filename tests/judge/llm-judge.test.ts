import { runJudge, _setQueryFn } from "../../src/judge/llm-judge";
import type { JudgeInput } from "../../src/judge/llm-judge";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "../../src/judge/judge-prompt";
import type { JudgePromptInput } from "../../src/judge/judge-prompt";
import { parseJudgeResponse } from "../../src/judge/verdict";
import type { RawJudgeResponse } from "../../src/judge/verdict";
import type { AdapterConfig, VerificationResult } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Mock SDK types ────────────────────────────────────────────────────

interface MockSDKMessage {
  type: string;
  subtype?: string;
  result?: string;
  [key: string]: unknown;
}

type MockQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<MockSDKMessage, void>;

// ─── Test helpers ──────────────────────────────────────────────────────

function* makeSuccessGenerator(
  responseJson: Record<string, unknown>,
): Generator<MockSDKMessage, void> {
  yield {
    type: "result",
    subtype: "success",
    result: JSON.stringify(responseJson),
  };
}

function createMockQueryFn(responseJson: Record<string, unknown>): {
  fn: MockQueryFn;
  calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

  const fn = function (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncGenerator<MockSDKMessage, void> {
    calls.push(params);
    const syncGen = makeSuccessGenerator(responseJson);
    const asyncGen: AsyncGenerator<MockSDKMessage, void> = {
      next: () => Promise.resolve(syncGen.next()),
      return: (value: void) => Promise.resolve(syncGen.return(value)),
      throw: (e: unknown) => Promise.resolve(syncGen.throw(e)),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return asyncGen;
  };

  return { fn, calls };
}

function makeErrorAsyncGenerator(errorMessage: string): AsyncGenerator<MockSDKMessage, void> {
  return {
    next: () => Promise.reject(new Error(errorMessage)),
    return: () => Promise.resolve({ done: true as const, value: undefined }),
    throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function createErrorQueryFn(errorMessage: string): MockQueryFn {
  return function () {
    return makeErrorAsyncGenerator(errorMessage);
  };
}

function createRetryQueryFn(
  failCount: number,
  errorMessage: string,
  successResponse: Record<string, unknown>,
): { fn: MockQueryFn; callCount: () => number } {
  let count = 0;

  const fn = function (): AsyncGenerator<MockSDKMessage, void> {
    count++;
    if (count <= failCount) {
      return makeErrorAsyncGenerator(errorMessage);
    }
    const syncGen = makeSuccessGenerator(successResponse);
    return {
      next: () => Promise.resolve(syncGen.next()),
      return: (value: void) => Promise.resolve(syncGen.return(value)),
      throw: (e: unknown) => Promise.resolve(syncGen.throw(e)),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };

  return { fn, callCount: () => count };
}

function makeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    allPassed: true,
    commands: [
      { name: "tests", passed: true, output: "42 tests passed" },
      { name: "lint", passed: true, output: "no warnings" },
    ],
    conventionChecks: [],
    ...overrides,
  };
}

function makeJudgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    taskSpec:
      "# TASK-042: Add email validation\n\n## Success Criteria\n- [ ] Invalid emails return 422\n- [ ] All existing tests pass",
    gitDiff:
      "diff --git a/src/validators.ts b/src/validators.ts\n+export function validateEmail(email: string): boolean {\n+  return /^[^@]+@[^@]+$/.test(email);\n+}",
    verificationResults: makeVerificationResult(),
    task: undefined,
    changedFiles: undefined,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
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
    config,
    projectRoot: "/fake/project/root",
    conventionsDoc: "Use Express + Sequelize. camelCase in JS.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

// ─── Tests: parseJudgeResponse ──────────────────────────────────────

describe("parseJudgeResponse", () => {
  test("should parse a valid APPROVE response", () => {
    const raw: RawJudgeResponse = {
      verdict: "APPROVE",
      confidence: 0.95,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "All success criteria met. Clean implementation.",
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("APPROVE");
    expect(result.confidence).toBe(0.95);
    expect(result.scopeViolations).toEqual([]);
    expect(result.criteriaGaps).toEqual([]);
    expect(result.qualityIssues).toEqual([]);
    expect(result.feedback).toBe("All success criteria met. Clean implementation.");
  });

  test("should parse a valid REVISE response with feedback", () => {
    const raw: RawJudgeResponse = {
      verdict: "REVISE",
      confidence: 0.7,
      scope_violations: ["Modified unrelated config file"],
      criteria_gaps: ["Email validation edge case not covered"],
      quality_issues: [],
      feedback: "Revert changes to config file and add edge case tests.",
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("REVISE");
    expect(result.confidence).toBe(0.7);
    expect(result.scopeViolations).toEqual(["Modified unrelated config file"]);
    expect(result.criteriaGaps).toEqual(["Email validation edge case not covered"]);
    expect(result.feedback).toContain("Revert changes to config file");
  });

  test("should parse a valid REJECT response", () => {
    const raw: RawJudgeResponse = {
      verdict: "REJECT",
      confidence: 0.9,
      scope_violations: ["Deleted test suite"],
      criteria_gaps: ["No criteria met"],
      quality_issues: ["Removed existing tests instead of adding new ones"],
      feedback: "Fundamental approach is wrong. Tests were deleted.",
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("REJECT");
    expect(result.confidence).toBe(0.9);
    expect(result.scopeViolations).toEqual(["Deleted test suite"]);
    expect(result.qualityIssues).toEqual(["Removed existing tests instead of adding new ones"]);
  });

  test("should clamp confidence above 1 to 1", () => {
    const raw: RawJudgeResponse = {
      verdict: "APPROVE",
      confidence: 1.5,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "",
    };

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.confidence).toBe(1);
  });

  test("should clamp confidence below 0 to 0", () => {
    const raw: RawJudgeResponse = {
      verdict: "APPROVE",
      confidence: -0.5,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "",
    };

    const result = parseJudgeResponse(JSON.stringify(raw));
    expect(result.confidence).toBe(0);
  });

  test("should default missing arrays to empty arrays", () => {
    const rawJson = JSON.stringify({
      verdict: "APPROVE",
      confidence: 0.8,
    });

    const result = parseJudgeResponse(rawJson);

    expect(result.scopeViolations).toEqual([]);
    expect(result.criteriaGaps).toEqual([]);
    expect(result.qualityIssues).toEqual([]);
    expect(result.feedback).toBe("");
  });

  test("should throw on invalid JSON", () => {
    expect(() => parseJudgeResponse("not json")).toThrow("Failed to parse judge response as JSON");
  });

  test("should throw on invalid verdict value", () => {
    const raw = JSON.stringify({
      verdict: "MAYBE",
      confidence: 0.5,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "",
    });

    expect(() => parseJudgeResponse(raw)).toThrow('Invalid judge verdict: "MAYBE"');
  });

  test("should throw on missing verdict", () => {
    const raw = JSON.stringify({
      confidence: 0.5,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "",
    });

    expect(() => parseJudgeResponse(raw)).toThrow("Invalid judge verdict");
  });

  test("should throw on missing confidence", () => {
    const raw = JSON.stringify({
      verdict: "APPROVE",
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "",
    });

    expect(() => parseJudgeResponse(raw)).toThrow(
      "Judge response missing required confidence field",
    );
  });

  test("should parse criteria_evaluation array when present", () => {
    const raw: RawJudgeResponse = {
      verdict: "REVISE",
      confidence: 0.85,
      scope_violations: [],
      criteria_gaps: ["maxTasks limit not enforced"],
      quality_issues: [],
      feedback: "The maxTasks parameter is only passed to the LLM prompt, not enforced in code.",
      criteria_evaluation: [
        {
          criterion: "Enforces maxTasks limit of 5",
          status: "PARTIAL",
          evidence: "planner-prompt.ts:46",
          reasoning:
            "maxTasks is interpolated into the prompt but no code enforces this if LLM returns more",
          enforcement_type: "llm_instruction_only",
        },
        {
          criterion: "Validates task dependencies",
          status: "PASS",
          evidence: "task-validator.ts:123-145",
          reasoning: "Dependencies are validated with Set lookups and proper error handling",
          enforcement_type: "deterministic_code",
        },
      ],
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.criteriaEvaluation).toBeDefined();
    expect(result.criteriaEvaluation).toHaveLength(2);

    const firstEval = result.criteriaEvaluation![0];
    expect(firstEval.criterion).toBe("Enforces maxTasks limit of 5");
    expect(firstEval.status).toBe("PARTIAL");
    expect(firstEval.evidence).toBe("planner-prompt.ts:46");
    expect(firstEval.reasoning).toContain("no code enforces this");
    expect(firstEval.enforcement_type).toBe("llm_instruction_only");

    const secondEval = result.criteriaEvaluation![1];
    expect(secondEval.status).toBe("PASS");
    expect(secondEval.enforcement_type).toBe("deterministic_code");
  });

  test("should auto-derive criteria_gaps from criteria_evaluation if gaps empty", () => {
    const raw: RawJudgeResponse = {
      verdict: "REVISE",
      confidence: 0.8,
      scope_violations: [],
      criteria_gaps: [], // Empty array
      quality_issues: [],
      feedback: "Some criteria need enforcement",
      criteria_evaluation: [
        {
          criterion: "Criterion A",
          status: "PASS",
          evidence: "file.ts:10",
          reasoning: "Good",
          enforcement_type: "deterministic_code",
        },
        {
          criterion: "Criterion B",
          status: "FAIL",
          evidence: "not found",
          reasoning: "Missing",
          enforcement_type: "not_implemented",
        },
        {
          criterion: "Criterion C",
          status: "PARTIAL",
          evidence: "file.ts:20",
          reasoning: "LLM dependent",
          enforcement_type: "llm_instruction_only",
        },
      ],
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    // Should auto-populate criteria_gaps with non-PASS criteria
    expect(result.criteriaGaps).toHaveLength(2);
    expect(result.criteriaGaps).toContain("Criterion B");
    expect(result.criteriaGaps).toContain("Criterion C");
  });

  test("should throw on invalid criterion status", () => {
    const raw = JSON.stringify({
      verdict: "APPROVE",
      confidence: 0.9,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "Good",
      criteria_evaluation: [
        {
          criterion: "Test",
          status: "MAYBE", // Invalid
          evidence: "file.ts:1",
          reasoning: "unclear",
          enforcement_type: "deterministic_code",
        },
      ],
    });

    expect(() => parseJudgeResponse(raw)).toThrow('Invalid criterion status: "MAYBE"');
  });

  test("should throw on invalid enforcement_type", () => {
    const raw = JSON.stringify({
      verdict: "APPROVE",
      confidence: 0.9,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "Good",
      criteria_evaluation: [
        {
          criterion: "Test",
          status: "PASS",
          evidence: "file.ts:1",
          reasoning: "good",
          enforcement_type: "magic", // Invalid
        },
      ],
    });

    expect(() => parseJudgeResponse(raw)).toThrow('Invalid enforcement_type: "magic"');
  });

  test("should handle backward compatibility with old format", () => {
    const raw: RawJudgeResponse = {
      verdict: "APPROVE",
      confidence: 0.95,
      scope_violations: [],
      criteria_gaps: [],
      quality_issues: [],
      feedback: "All good",
      // No criteria_evaluation field
    };

    const result = parseJudgeResponse(JSON.stringify(raw));

    expect(result.verdict).toBe("APPROVE");
    expect(result.criteriaEvaluation).toBeUndefined();
    expect(result.criteriaGaps).toEqual([]);
  });
});

// ─── Tests: buildJudgePrompt ────────────────────────────────────────

describe("buildJudgePrompt", () => {
  function makePromptInput(overrides: Partial<JudgePromptInput> = {}): JudgePromptInput {
    return {
      taskSpec: "# TASK-042: Add email validation\n\n## Success Criteria\n- [ ] Returns 422",
      gitDiff:
        "diff --git a/src/validators.ts b/src/validators.ts\n+export function validateEmail() {}",
      verificationResults: makeVerificationResult(),
      judgeCriteria: "",
      ...overrides,
    };
  }

  test("should include the task spec in the prompt", () => {
    const input = makePromptInput();
    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain(input.taskSpec);
  });

  test("should include the git diff in the prompt", () => {
    const input = makePromptInput();
    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain(input.gitDiff);
  });

  test("should include verification results in the prompt", () => {
    const input = makePromptInput();
    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("ALL PASSED");
    expect(prompt).toContain("tests");
    expect(prompt).toContain("PASS");
  });

  test("should include failed verification details", () => {
    const input = makePromptInput({
      verificationResults: makeVerificationResult({
        allPassed: false,
        commands: [
          { name: "tests", passed: false, output: "3 tests failed" },
          { name: "lint", passed: true, output: "no warnings" },
        ],
      }),
    });

    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("SOME FAILED");
    expect(prompt).toContain("FAIL (REQUIRED; BLOCKING)");
    expect(prompt).toContain("3 tests failed");
  });

  test("labels skipped and unavailable optional checks as non-blocking", () => {
    const input = makePromptInput({
      verificationResults: makeVerificationResult({
        allPassed: true,
        commands: [
          {
            name: "browser-smoke",
            passed: false,
            required: false,
            status: "optional-unavailable",
            output: "TASK-006 browser harness is not integrated",
          },
          {
            name: "visual-sweep",
            passed: false,
            required: false,
            status: "skipped",
            output: "Optional verifier execution was disabled",
          },
        ],
      }),
    });

    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("Overall: ALL PASSED");
    expect(prompt).toContain("**browser-smoke**: OPTIONAL UNAVAILABLE (NON-BLOCKING)");
    expect(prompt).toContain("**visual-sweep**: SKIPPED (OPTIONAL; NON-BLOCKING)");
    expect(prompt).not.toContain("**browser-smoke**: FAIL");
    expect(prompt).not.toContain("**visual-sweep**: FAIL");
    expect(JUDGE_SYSTEM_PROMPT).toContain("MUST NOT be the sole basis\n  for REVISE or REJECT");
  });

  test("should include universal evaluation criteria in system prompt", () => {
    // Static evaluation criteria are now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("Additional Checks");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Scope Violations");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Quality Issues");
  });

  test("should include project-specific criteria when provided", () => {
    const criteria =
      "All Sequelize queries include example_id filtering.\nError responses use AppError subclasses.";
    const input = makePromptInput({ judgeCriteria: criteria });
    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("Project-Specific Evaluation Criteria");
    expect(prompt).toContain("All Sequelize queries include example_id filtering");
    expect(prompt).toContain("Error responses use AppError subclasses");
  });

  test("should NOT include project-specific section when criteria is empty", () => {
    const input = makePromptInput({ judgeCriteria: "" });
    const prompt = buildJudgePrompt(input);

    expect(prompt).not.toContain("Project-Specific Evaluation Criteria");
  });

  test("should NOT include project-specific section when criteria is whitespace only", () => {
    const input = makePromptInput({ judgeCriteria: "   \n\n  " });
    const prompt = buildJudgePrompt(input);

    expect(prompt).not.toContain("Project-Specific Evaluation Criteria");
  });

  test("should include JSON verdict format instructions in system prompt", () => {
    // JSON response format is now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain('"verdict"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"confidence"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"scope_violations"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"criteria_gaps"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"quality_issues"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"feedback"');
  });

  test("should include verdict guideline descriptions in system prompt", () => {
    // Verdict guidelines are now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("APPROVE");
    expect(JUDGE_SYSTEM_PROMPT).toContain("REVISE");
    expect(JUDGE_SYSTEM_PROMPT).toContain("REJECT");
  });

  test("should include the system context preamble in system prompt", () => {
    // Preamble is now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      "You are an adversarial code review judge evaluating changes made by a background coding agent",
    );
  });

  test("should include convention check results when present", () => {
    const input = makePromptInput({
      verificationResults: makeVerificationResult({
        conventionChecks: [
          { name: "layer-violations", passed: true, output: "Pass" },
          {
            name: "tenant-isolation",
            passed: false,
            output: "Missing example_id filter in query at line 42",
          },
        ],
      }),
    });

    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("Convention Checks");
    expect(prompt).toContain("layer-violations");
    expect(prompt).toContain("tenant-isolation");
    expect(prompt).toContain("Missing example_id filter");
  });

  test("should include adversarial framing in system prompt", () => {
    // Adversarial framing is now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("adversarial code review judge");
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      "find gaps where the implementation claims to satisfy requirements",
    );
  });

  test("should include per-criterion evaluation instructions in system prompt", () => {
    // Per-criterion instructions are now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("Per-Criterion Evaluation Instructions");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Identify the enforcement mechanism");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Classify the enforcement type");
    expect(JUDGE_SYSTEM_PROMPT).toContain("deterministic_code");
    expect(JUDGE_SYSTEM_PROMPT).toContain("llm_instruction_only");
    expect(JUDGE_SYSTEM_PROMPT).toContain("not_implemented");
  });

  test("should include criteria_evaluation in JSON response format in system prompt", () => {
    // JSON response format is now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain('"criteria_evaluation"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"status": "PASS" | "FAIL" | "PARTIAL"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"enforcement_type"');
  });

  test("should extract success criteria when parsedTask provided", () => {
    const parsedTask = {
      id: "TASK-042",
      title: "Test task",
      priority: "P1-HIGH" as const,
      effort: "2 hours",
      status: "IN_PROGRESS" as const,
      blockedBy: [],
      blocks: [],
      supersededBy: [],
      supersedes: [],
      relevanceReview: "",
      conventions: [],
      tags: [],
      problemStatement: "Problem",
      currentState: "Current",
      recommendedApproach: "Approach",
      filesToModify: [],
      successCriteria: [
        "Criterion A: Must validate input",
        "Criterion B: Must enforce limits",
        "Criterion C: Must handle errors",
      ],
      testingRequirements: [],
      contextReferences: [],
      rawContent: "",
    };

    const input = makePromptInput({ parsedTask });
    const prompt = buildJudgePrompt(input);

    expect(prompt).toContain("Extracted Success Criteria");
    expect(prompt).toContain("1. Criterion A: Must validate input");
    expect(prompt).toContain("2. Criterion B: Must enforce limits");
    expect(prompt).toContain("3. Criterion C: Must handle errors");
  });

  test("should include edge case testing instructions in system prompt", () => {
    // Edge case instructions are now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("Test edge cases");
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      "What happens if the LLM returns more items than requested?",
    );
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      "What happens if external input violates the constraint?",
    );
  });

  test("should include recommendations and implementation details check in system prompt", () => {
    // Implementation checks are now in JUDGE_SYSTEM_PROMPT for caching
    expect(JUDGE_SYSTEM_PROMPT).toContain("Recommended Approach");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Implementation Details");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Testing Requirements");
  });
});

// ─── Tests: runJudge ────────────────────────────────────────────────

describe("runJudge", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  describe("clean diff -> APPROVE", () => {
    test("should return APPROVE verdict for a clean implementation", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.92,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "All success criteria met. Clean implementation following existing patterns.",
        criteria_evaluation: [
          {
            criterion: "Invalid emails return 422",
            status: "PASS",
            evidence: "src/validators.ts:15-20",
            reasoning: "Email validation function with proper error handling returning 422 status",
            enforcement_type: "deterministic_code",
          },
          {
            criterion: "All existing tests pass",
            status: "PASS",
            evidence: "Verification results show all tests passing",
            reasoning: "No tests were modified or deleted, verification confirms all pass",
            enforcement_type: "deterministic_code",
          },
        ],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const result = await runJudge(makeJudgeInput(), makeAdapter());

      expect(result.verdict).toBe("APPROVE");
      expect(result.confidence).toBe(0.92);
      expect(result.scopeViolations).toEqual([]);
      expect(result.criteriaGaps).toEqual([]);
      expect(result.qualityIssues).toEqual([]);
      expect(result.feedback).toContain("All success criteria met");
      expect(result.judgmentTrace?.map((entry) => entry.phase)).toEqual([
        "raw",
        "enforcement",
        "path_audit",
      ]);
      expect(result.judgmentTrace?.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
      expect(result.judgmentDecision?.action).toBe("continue");

      // Check criteria evaluation
      expect(result.criteriaEvaluation).toBeDefined();
      expect(result.criteriaEvaluation).toHaveLength(2);
      expect(result.criteriaEvaluation![0].status).toBe("PASS");
      expect(result.criteriaEvaluation![0].enforcement_type).toBe("deterministic_code");
    });

    test("reconciles a legacy optional failure from a resumed checkpoint against adapter config", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Required checks and task criteria pass.",
      };
      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);
      const adapter = makeAdapter();
      adapter.config.verification.commands.push({
        name: "browser-smoke",
        command: "npm run test:browser",
        required: false,
        timeout: 300,
      });

      const result = await runJudge(
        makeJudgeInput({
          verificationResults: {
            allPassed: true,
            commands: [
              {
                name: "browser-smoke",
                passed: false,
                output: "TASK-006 browser harness is not integrated",
              },
            ],
            conventionChecks: [],
          },
        }),
        adapter,
      );

      expect(result.verdict).toBe("APPROVE");
      expect(calls).toHaveLength(1);
      const promptSent = calls[0]?.prompt ?? "";
      expect(promptSent).toContain("**browser-smoke**: OPTIONAL UNAVAILABLE (NON-BLOCKING)");
      expect(promptSent).not.toContain("**browser-smoke**: FAIL");
    });
  });

  describe("out-of-scope changes -> REVISE with feedback", () => {
    test("should return REVISE verdict when changes exceed task scope", async () => {
      const responseJson = {
        verdict: "REVISE",
        confidence: 0.8,
        scope_violations: [
          "Modified src/config.ts which is not in the task's Files to Modify list",
          "Added logging to unrelated authentication module",
        ],
        criteria_gaps: [],
        quality_issues: [],
        feedback:
          "Revert changes to src/config.ts and remove logging additions to auth module. Only modify files listed in the task spec.",
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const input = makeJudgeInput({
        gitDiff:
          "diff --git a/src/validators.ts b/src/validators.ts\n+export function validateEmail() {}\n\ndiff --git a/src/config.ts b/src/config.ts\n-const logLevel = 'info';\n+const logLevel = 'debug';",
      });

      const result = await runJudge(input, makeAdapter());

      expect(result.verdict).toBe("REVISE");
      expect(result.scopeViolations).toHaveLength(2);
      expect(result.scopeViolations[0]).toContain("src/config.ts");
      expect(result.feedback).toContain("Revert changes");
    });
  });

  describe("deleted tests -> REJECT", () => {
    test("should return REJECT verdict when tests are deleted", async () => {
      const responseJson = {
        verdict: "REJECT",
        confidence: 0.95,
        scope_violations: ["Deleted existing test file tests/auth.test.ts"],
        criteria_gaps: [
          "Success criterion 'All existing tests pass' cannot be met — tests were deleted",
        ],
        quality_issues: [
          "Removing tests to make verification pass is a fundamental approach violation",
        ],
        feedback:
          "The agent deleted existing tests instead of ensuring they pass. This is a fundamental approach error. Abort.",
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const input = makeJudgeInput({
        gitDiff:
          "diff --git a/tests/auth.test.ts b/tests/auth.test.ts\ndeleted file mode 100644\n-describe('auth', () => {\n-  test('login works', () => {\n-    expect(true).toBe(true);\n-  });\n-});",
      });

      const result = await runJudge(input, makeAdapter());

      expect(result.verdict).toBe("REJECT");
      expect(result.confidence).toBe(0.95);
      expect(result.scopeViolations).toContain("Deleted existing test file tests/auth.test.ts");
      expect(result.qualityIssues).toHaveLength(1);
      expect(result.feedback).toContain("deleted existing tests");
    });
  });

  describe("project-specific criteria loaded and included in prompt", () => {
    test("should pass project-specific criteria to the judge prompt", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.88,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Meets all universal and project-specific criteria.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const criteria =
        "All Sequelize queries include example_id filtering.\nError responses use AppError subclasses.";
      const adapter = makeAdapter({ judgeCriteria: criteria });

      await runJudge(makeJudgeInput(), adapter);

      expect(calls).toHaveLength(1);
      const promptSent = calls[0]?.prompt ?? "";
      expect(promptSent).toContain("Project-Specific Evaluation Criteria");
      expect(promptSent).toContain("example_id filtering");
      expect(promptSent).toContain("AppError subclasses");
    });
  });

  describe("missing judge-criteria.md -> universal-only evaluation", () => {
    test("should use only universal criteria when judgeCriteria is empty", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.85,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "All universal criteria met.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const adapter = makeAdapter({ judgeCriteria: "" });

      await runJudge(makeJudgeInput(), adapter);

      expect(calls).toHaveLength(1);
      // Universal criteria are now in the system prompt (for caching)
      const systemPromptSent = (calls[0]?.options?.systemPrompt as string) ?? "";
      expect(systemPromptSent).toContain("Additional Checks");
      expect(systemPromptSent).toContain("Scope Violations");
      expect(systemPromptSent).toContain("Quality Issues");
      // User prompt should not include project-specific criteria when empty
      const promptSent = calls[0]?.prompt ?? "";
      expect(promptSent).not.toContain("Project-Specific Evaluation Criteria");
    });
  });

  describe("SDK options", () => {
    test("should pass correct options to SDK query", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      await runJudge(makeJudgeInput(), makeAdapter());

      expect(calls).toHaveLength(1);
      const callArgs = calls[0];
      expect(callArgs?.options).toEqual(
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          maxTurns: 30,
          systemPrompt: JUDGE_SYSTEM_PROMPT,
          allowedTools: ["Read", "Glob", "Grep"],
          disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
          permissionMode: "bypassPermissions",
          cwd: "/fake/project/root",
        }),
      );
    });

    test("should use adapter judgeModel by default", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const adapter = makeAdapter();
      adapter.config.agent.judgeModel = "claude-haiku-3-5-20241022";

      await runJudge(makeJudgeInput(), adapter);

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          model: "claude-haiku-3-5-20241022",
        }),
      );
    });

    test("should allow overriding model via options", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      await runJudge(makeJudgeInput(), makeAdapter(), {
        model: "claude-opus-4-6",
      });

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          model: "claude-opus-4-6",
        }),
      );
    });

    test("should allow overriding maxTurns via options", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      await runJudge(makeJudgeInput(), makeAdapter(), {
        maxTurns: 10,
      });

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          maxTurns: 10,
        }),
      );
    });

    test("should use adapter projectRoot as cwd", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good.",
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const adapter = makeAdapter({ projectRoot: "/my/custom/project" });

      await runJudge(makeJudgeInput(), adapter);

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          cwd: "/my/custom/project",
        }),
      );
    });
  });

  describe("error handling", () => {
    test("should retry once on SDK error then throw", async () => {
      const fn = createErrorQueryFn("Connection timeout");
      _setQueryFn(fn);

      await expect(runJudge(makeJudgeInput(), makeAdapter())).rejects.toThrow(
        "Judge evaluation failed after retry",
      );
    });

    test("should succeed on second attempt after initial failure", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good on retry.",
      };

      const { fn, callCount } = createRetryQueryFn(1, "Temporary failure", responseJson);
      _setQueryFn(fn);

      const result = await runJudge(makeJudgeInput(), makeAdapter());

      expect(result.verdict).toBe("APPROVE");
      expect(callCount()).toBe(2);
    });

    test("should include original error message in thrown error", async () => {
      const fn = createErrorQueryFn("API rate limit exceeded");
      _setQueryFn(fn);

      await expect(runJudge(makeJudgeInput(), makeAdapter())).rejects.toThrow(
        "API rate limit exceeded",
      );
    });

    test("should throw if SDK returns no result message", async () => {
      const fn: MockQueryFn = function () {
        const asyncGen: AsyncGenerator<MockSDKMessage, void> = {
          next: () => Promise.resolve({ done: true as const, value: undefined }),
          return: () => Promise.resolve({ done: true as const, value: undefined }),
          throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return asyncGen;
      };

      _setQueryFn(fn);

      await expect(runJudge(makeJudgeInput(), makeAdapter())).rejects.toThrow(
        "Judge evaluation failed after retry",
      );
    });

    test("should handle non-Error throws from SDK", async () => {
      const nonErrorFn: MockQueryFn = function () {
        return {
          next: () => Promise.reject(new Error("non-error wrapper")),
          return: () => Promise.resolve({ done: true as const, value: undefined }),
          throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };

      _setQueryFn(nonErrorFn);

      await expect(runJudge(makeJudgeInput(), makeAdapter())).rejects.toThrow(
        "Judge evaluation failed after retry",
      );
    });
  });

  describe("blueprint checks integration", () => {
    test("should accept blueprintChecks and include compliance results", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "All criteria met with blueprint compliance checks.",
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const input = makeJudgeInput({
        task: {
          id: "TASK-042",
          title: "Test",
          priority: "P1-HIGH" as const,
          effort: "2h",
          status: "IN_PROGRESS" as const,
          blockedBy: [],
          blocks: [],
          supersededBy: [],
          supersedes: [],
          relevanceReview: "",
          conventions: [],
          tags: [],
          problemStatement: "",
          currentState: "",
          recommendedApproach: "",
          filesToModify: [],
          successCriteria: ["Validates email format"],
          testingRequirements: [],
          contextReferences: [],
          rawContent: "",
        },
        gitDiff:
          "diff --git a/src/validators.ts b/src/validators.ts\n+export function validateEmail(email: string) {\n+  return /^[^@]+@[^@]+$/.test(email);\n+}",
        changedFiles: ["src/validators.ts"],
      });

      const result = await runJudge(input, makeAdapter(), {
        blueprintChecks: [
          {
            name: "blueprint-0: Validates email format",
            criterionMatch: "Validates email format",
            type: "grep",
            pattern: "validateEmail",
            glob: "src/**/*.ts",
            severity: "flag",
          },
        ],
      });

      expect(result.verdict).toBe("APPROVE");
      // complianceChecks should be populated
      expect(result.complianceChecks).toBeDefined();
    });

    test("should work identically without blueprintChecks option", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Good without blueprint checks.",
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      // Call without blueprintChecks — should not error
      const result = await runJudge(makeJudgeInput(), makeAdapter());

      expect(result.verdict).toBe("APPROVE");
      expect(result.confidence).toBe(0.9);
    });
  });

  describe("adversarial evaluation catches llm-only enforcement", () => {
    test("should return REVISE for criteria that rely only on LLM compliance", async () => {
      const responseJson = {
        verdict: "REVISE",
        confidence: 0.88,
        scope_violations: [],
        criteria_gaps: ["Enforces maxTasks limit of 5"],
        quality_issues: [],
        feedback:
          "The maxTasks limit is only mentioned in the LLM prompt. Add code enforcement to ensure no more than 5 tasks are processed even if the LLM returns more.",
        criteria_evaluation: [
          {
            criterion: "Enforces maxTasks limit of 5",
            status: "PARTIAL",
            evidence: "src/planner-prompt.ts:46",
            reasoning:
              "The maxTasks value is interpolated into the prompt template but there's no code that validates or enforces this limit on the LLM response",
            enforcement_type: "llm_instruction_only",
          },
          {
            criterion: "Validates task dependencies exist",
            status: "PASS",
            evidence: "src/task-validator.ts:123-128",
            reasoning:
              "Dependencies are checked against a Set of valid task IDs with proper error handling",
            enforcement_type: "deterministic_code",
          },
        ],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const input = makeJudgeInput({
        taskSpec:
          "# TASK-024: Planner Agent\n\n## Success Criteria\n- [ ] Enforces maxTasks limit of 5\n- [ ] Validates task dependencies exist",
      });

      const result = await runJudge(input, makeAdapter());

      expect(result.verdict).toBe("REVISE");
      expect(result.criteriaEvaluation).toBeDefined();

      const maxTasksEval = result.criteriaEvaluation!.find((e) => e.criterion.includes("maxTasks"));
      expect(maxTasksEval).toBeDefined();
      expect(maxTasksEval!.status).toBe("PARTIAL");
      expect(maxTasksEval!.enforcement_type).toBe("llm_instruction_only");
      expect(maxTasksEval!.reasoning).toContain("no code that validates");

      expect(result.feedback).toContain("Add code enforcement");
    });
  });

  describe("blueprint checks integration (TASK-044)", () => {
    test("should accept blueprintChecks in options and merge with adapter checks", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.95,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "All criteria met",
        criteria_evaluation: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const blueprintChecks = [
        {
          name: "blueprint-0: Exports validateEmail function",
          criterionMatch: "Exports validateEmail function",
          type: "grep" as const,
          pattern: "export function validateEmail",
          glob: "src/validators.ts",
          severity: "flag" as const,
        },
      ];

      // Just verify the function accepts the blueprintChecks parameter without error
      const input = makeJudgeInput({
        taskSpec: "# TASK-TEST\n\n## Success Criteria\n- [ ] Implements feature",
      });

      const result = await runJudge(input, makeAdapter(), { blueprintChecks });

      expect(result.verdict).toBe("APPROVE");
    });

    test("should work without blueprintChecks (backward compatibility)", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.95,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "All good",
        criteria_evaluation: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const input = makeJudgeInput({
        taskSpec: "# TASK-TEST\n\n## Success Criteria\n- [ ] Implements feature",
      });

      const result = await runJudge(input, makeAdapter());

      expect(result.verdict).toBe("APPROVE");
    });
  });

  describe("enforcement verdict constraints (TASK-1200)", () => {
    test("downgrades a mocked APPROVE with an llm_instruction_only PASS to REVISE", async () => {
      const responseJson = {
        verdict: "APPROVE",
        confidence: 0.9,
        scope_violations: [],
        criteria_gaps: [],
        quality_issues: [],
        feedback: "Looks complete.",
        criteria_evaluation: [
          {
            criterion: "Enforces maxTasks limit of 5",
            status: "PASS",
            evidence: "src/planner-prompt.ts:46",
            reasoning: "The prompt tells the LLM to return at most 5 tasks",
            enforcement_type: "llm_instruction_only",
          },
        ],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const result = await runJudge(makeJudgeInput(), makeAdapter());

      expect(result.verdict).toBe("REVISE");
      expect(result.feedback.startsWith("[ENFORCEMENT OVERRIDE]")).toBe(true);
      expect(result.criteriaEvaluation![0].status).toBe("PARTIAL");
      expect(result.enforcementDemotions).toHaveLength(1);
      expect(result.enforcementDemotions![0].rule).toBe("llm_instruction_only");
      expect(result.criteriaGaps).toContain("Enforces maxTasks limit of 5");
      expect(result.judgmentTrace?.[0].decision.action).toBe("continue");
      expect(result.judgmentTrace?.[1].decision.action).toBe("repair");
      expect(result.judgmentDecision?.signals).toContainEqual(
        expect.objectContaining({ code: "path_audit" }),
      );
    });

    test("path-validation override composes on the constrained result and preserves demotions", async () => {
      // Real temp projectRoot so path validation has one valid + two fake paths.
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-judge-test-"));
      fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, "src", "real.ts"), "export const x = 1;\n");

      try {
        const responseJson = {
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
              evidence: "src/real.ts:1",
              reasoning: "Prompt-only enforcement",
              enforcement_type: "llm_instruction_only",
            },
            {
              criterion: "Validates dependencies",
              status: "PASS",
              evidence: "src/fake-a.ts:2 and also src/fake-b.ts:3",
              reasoning: "Checked",
              enforcement_type: "deterministic_code",
            },
          ],
        };

        const { fn } = createMockQueryFn(responseJson);
        _setQueryFn(fn);

        const result = await runJudge(makeJudgeInput(), makeAdapter({ projectRoot: tmpRoot }));

        // Path validation fired (2 of 3 cited paths are fake)...
        expect(result.verdict).toBe("REVISE");
        expect(result.feedback).toContain("[PATH VALIDATION OVERRIDE]");
        // ...and the enforcement constraint applied first is fully preserved.
        expect(result.feedback).toContain("[ENFORCEMENT OVERRIDE]");
        expect(result.enforcementDemotions).toHaveLength(1);
        expect(result.judgmentTrace?.[2]).toMatchObject({
          sequence: 2,
          phase: "path_audit",
          decision: {
            action: "repair",
            safetyFloor: { passed: true },
          },
        });
        expect(result.judgmentTrace?.[2].decision.signals).toContainEqual(
          expect.objectContaining({ code: "path_audit_override" }),
        );
        const maxTasksEval = result.criteriaEvaluation!.find((e) =>
          e.criterion.includes("maxTasks"),
        );
        expect(maxTasksEval!.status).toBe("PARTIAL");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });
});
