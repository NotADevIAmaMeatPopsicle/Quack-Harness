import {
  evaluateTaskDepth,
  batchEvaluateTaskDepth,
  _setQueryFn,
  _setSdkTimeoutMs,
} from "../../src/gate/depth-evaluator";
import { buildDepthPrompt } from "../../src/gate/depth-prompt";
import { ParsedTask, TaskPriority, TaskStatus, TaskType } from "../../src/core/types";

/**
 * Minimal SDK message shape matching the local type in depth-evaluator.
 */
interface MockSDKMessage {
  type: string;
  subtype?: string;
  result?: string;
}

/**
 * Type matching the QueryFn shape used internally by depth-evaluator.
 */
type MockQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<MockSDKMessage, void>;

/**
 * Creates an async generator that yields a single success result message.
 */
function* makeSuccessGenerator(
  responseJson: Record<string, unknown>,
): Generator<MockSDKMessage, void> {
  yield {
    type: "result",
    subtype: "success",
    result: JSON.stringify(responseJson),
  };
}

/**
 * Helper to create a mock query function that yields a success result.
 * Captures the call arguments for assertion.
 */
function createMockQueryFn(responseJson: Record<string, unknown>): {
  fn: MockQueryFn;
  calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

  // Use a synchronous generator wrapped as async to avoid lint warnings
  const fn = function (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncGenerator<MockSDKMessage, void> {
    calls.push(params);
    // Wrap sync generator as async generator
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

/**
 * Creates an async generator that immediately rejects with an error.
 */
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

/**
 * Helper to create a mock query function that throws an error.
 */
function createErrorQueryFn(errorMessage: string): MockQueryFn {
  return function () {
    return makeErrorAsyncGenerator(errorMessage);
  };
}

/**
 * Helper to create a mock query function that fails N times then succeeds.
 */
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

/**
 * Helper function to create a valid task for depth evaluation testing.
 */
function makeValidTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const baseTask: ParsedTask = {
    id: "TASK-042",
    title: "Add email validation to registration form",
    priority: "P1-HIGH" as TaskPriority,
    effort: "2-3 hours",
    status: "BACKLOG" as TaskStatus,
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: ["TASK-043"],
    conventions: ["ADR-012"],
    tags: ["backend", "validation"],
    problemStatement:
      "The registration form accepts any string as an email address. We need RFC 5322 compliant email validation.",
    currentState:
      "src/controllers/auth.controller.ts has a register() handler that passes raw input to the service layer without validation.",
    recommendedApproach:
      "Add a validateEmail() function in src/utils/validators.ts and call it from the registration controller.",
    filesToModify: [
      {
        path: "src/utils/validators.ts",
        action: "Create",
        notes: "Email validation function",
      },
      {
        path: "src/controllers/auth.controller.ts",
        action: "Modify",
        notes: "Add validation call before service layer",
      },
    ],
    successCriteria: [
      "Invalid emails return 422 with field-level error",
      "Valid emails proceed to registration",
      "All existing auth tests still pass",
    ],
    testingRequirements: [
      "Unit test for validateEmail() with valid and invalid cases",
      "Integration test for registration endpoint with invalid email",
    ],
    contextReferences: ["ADR-012: Input validation patterns"],
    rawContent:
      "# TASK-042: Add email validation to registration form\n\n## Problem Statement\nThe registration form accepts any string as an email...",
  };

  return { ...baseTask, ...overrides };
}

describe("buildDepthPrompt", () => {
  test("should interpolate task rawContent into the prompt", () => {
    const task = makeValidTask();
    const conventions = "Use Express + Sequelize. camelCase in JS.";

    const prompt = buildDepthPrompt(task, conventions);

    expect(prompt).toContain(task.rawContent);
  });

  test("should interpolate conventions summary into the prompt", () => {
    const task = makeValidTask();
    const conventions = "Use Express + Sequelize. camelCase in JS.";

    const prompt = buildDepthPrompt(task, conventions);

    expect(prompt).toContain(conventions);
  });

  test("should include all six evaluation dimensions", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("Problem Clarity");
    expect(prompt).toContain("Scope Boundedness");
    expect(prompt).toContain("Testability");
    expect(prompt).toContain("Convention Anchoring");
    expect(prompt).toContain("Implementation Specificity");
    expect(prompt).toContain("Verification Clarity");
  });

  test("should include new dimensions in JSON response format", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain('"implementation_specificity"');
    expect(prompt).toContain('"verification_clarity"');
    expect(prompt).toContain('"completeness"');
  });

  test("should include Completeness dimension text", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Does the task cover ALL layers implied by the spec?");
  });

  test("should include JSON response format instructions", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain('"ready"');
    expect(prompt).toContain('"overall_score"');
    expect(prompt).toContain('"scores"');
    expect(prompt).toContain('"deficiencies"');
    expect(prompt).toContain('"enrichment_suggestions"');
    expect(prompt).toContain('"implementation_specificity"');
    expect(prompt).toContain('"verification_clarity"');
  });

  test("should include the system context preamble", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("You are evaluating whether a task specification is detailed enough");
    expect(prompt).toContain("background coding agent to implement without human guidance");
  });

  test("should handle empty conventions summary", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "");

    expect(prompt).toContain("## Project Context\n");
    expect(prompt).toContain(task.rawContent);
  });

  test("should handle task with minimal rawContent", () => {
    const task = makeValidTask({ rawContent: "# TASK-001: Minimal" });
    const prompt = buildDepthPrompt(task, "some conventions");

    expect(prompt).toContain("# TASK-001: Minimal");
    expect(prompt).toContain("some conventions");
  });
});

describe("evaluateTaskDepth", () => {
  afterEach(() => {
    // Reset the injected query function after each test
    _setQueryFn(undefined);
  });

  describe("high-quality task evaluation", () => {
    test("should return ready=true when all scores are >= 2 and overall >= 4.7", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.8);
      expect(result.scores.clarity).toBe(5);
      expect(result.scores.scope).toBe(5);
      expect(result.scores.testability).toBe(4);
      expect(result.scores.conventions).toBe(5);
      expect(result.deficiencies).toEqual([]);
      expect(result.enrichmentSuggestions).toEqual([]);
    });

    test("should pass correct options to SDK query", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      await evaluateTaskDepth(task, "conventions summary");

      expect(calls).toHaveLength(1);
      const callArgs = calls[0];
      expect(callArgs?.options).toEqual(
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          maxTurns: 5,
          tools: [],
          outputFormat: expect.objectContaining({
            type: "json_schema",
          }) as Record<string, unknown>,
        }),
      );
    });

    test("should use custom model when specified", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      await evaluateTaskDepth(task, "conventions summary", {
        model: "claude-haiku-3-5-20241022",
      });

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          model: "claude-haiku-3-5-20241022",
        }),
      );
    });

    test("should pass custom maxTurns to SDK", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      await evaluateTaskDepth(task, "conventions", { maxTurns: 8 });

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          maxTurns: 8,
        }),
      );
    });

    test("should default maxTurns to 5", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn, calls } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      await evaluateTaskDepth(task, "conventions");

      expect(calls[0]?.options).toEqual(
        expect.objectContaining({
          maxTurns: 5,
        }),
      );
    });
  });

  describe("vague task evaluation", () => {
    test("should return ready=false when overall score is below 4.7", async () => {
      const responseJson = {
        ready: false,
        overall_score: 2.0,
        scores: { clarity: 2, scope: 2, testability: 2, conventions: 2 },
        deficiencies: [
          "Problem statement is too vague",
          "No specific file paths mentioned",
          "Success criteria are not testable",
        ],
        enrichment_suggestions: [
          "Add specific file paths that need modification",
          "Include concrete success criteria with test commands",
          "Reference relevant ADRs or convention documents",
        ],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask({
        rawContent: "# TASK-099: Improve the system\n\nMake things better.",
      });
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(false);
      expect(result.overallScore).toBe(2.0);
      expect(result.deficiencies).toHaveLength(3);
      expect(result.deficiencies).toContain("Problem statement is too vague");
      expect(result.enrichmentSuggestions).toHaveLength(3);
    });
  });

  describe("single dimension below threshold", () => {
    test("should stay ready with a low-dimension advisory when one score is below 2 and overall >= 4.7 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 1, conventions: 5 },
        deficiencies: ["No test criteria specified"],
        enrichment_suggestions: ["Add specific test requirements with expected outcomes"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      // A low sub-score informs but no longer vetoes readiness (v2 P0-4).
      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.8);
      expect(result.scores.testability).toBe(1);
      expect(
        result.deficiencies.some((d) => d.startsWith("ADVISORY:") && d.includes("scored 1 (< 2)")),
      ).toBe(true);
      expect(result.deficiencies).toContain("No test criteria specified");
    });

    test("should return ready=false when conventions score is 1", async () => {
      const responseJson = {
        ready: false,
        overall_score: 3.0,
        scores: { clarity: 4, scope: 3, testability: 4, conventions: 1 },
        deficiencies: ["No convention references"],
        enrichment_suggestions: ["Add ADR references"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(false);
      expect(result.scores.conventions).toBe(1);
    });
  });

  describe("boundary conditions for readiness", () => {
    test("should return ready=true at exact threshold: overall=4.7, all scores=2", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.7,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: ["Could improve in all dimensions"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.7);
    });

    test("should return ready=false at overall=4.6 even with all scores >= 2", async () => {
      const responseJson = {
        ready: false,
        overall_score: 4.6,
        scores: { clarity: 5, scope: 4, testability: 4, conventions: 5 },
        deficiencies: ["Slightly below threshold"],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(false);
      expect(result.overallScore).toBe(4.6);
    });
  });

  describe("field mapping", () => {
    test("should map overall_score to overallScore", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.7,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.overallScore).toBe(4.7);
    });

    test("should map enrichment_suggestions to enrichmentSuggestions", async () => {
      const responseJson = {
        ready: false,
        overall_score: 2.5,
        scores: { clarity: 3, scope: 2, testability: 2, conventions: 3 },
        deficiencies: ["Vague scope"],
        enrichment_suggestions: ["Add file list", "Add success criteria checklist"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.enrichmentSuggestions).toEqual([
        "Add file list",
        "Add success criteria checklist",
      ]);
    });
  });

  describe("new depth dimensions (implementation_specificity, verification_clarity, completeness)", () => {
    test("should map new dimensions when present in response", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 4,
          conventions: 5,
          implementation_specificity: 4,
          verification_clarity: 5,
          completeness: 4,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.scores.implementationSpecificity).toBe(4);
      expect(result.scores.verificationClarity).toBe(5);
      expect(result.scores.completeness).toBe(4);
    });

    test("should fall back to clarity/testability/scope when new dimensions absent", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      // Falls back: implementationSpecificity = clarity, verificationClarity = testability, completeness = scope
      expect(result.scores.implementationSpecificity).toBe(5);
      expect(result.scores.verificationClarity).toBe(4);
      expect(result.scores.completeness).toBe(5);
    });

    test("should return ready=false when new dimension below 2", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 1,
          verification_clarity: 5,
          completeness: 5,
        },
        deficiencies: ["No file references"],
        enrichment_suggestions: ["Add file paths"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      // A new dim < 2 informs via advisory; readiness rides the threshold (TASK-1300).
      expect(result.ready).toBe(true);
      expect(result.scores.implementationSpecificity).toBe(1);
      expect(result.deficiencies.some((d) => d.startsWith("ADVISORY:"))).toBe(true);
    });

    test("should stay ready with a low-dimension advisory when completeness is below 2 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 5,
          verification_clarity: 5,
          completeness: 1,
        },
        deficiencies: ["Backend work specified but no frontend success criteria"],
        enrichment_suggestions: ["Add frontend success criteria"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.scores.completeness).toBe(1);
      expect(
        result.deficiencies.some((d) => d.startsWith("ADVISORY:") && d.includes("Completeness")),
      ).toBe(true);
    });

    test("should not penalize missing new dims for readiness check", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.7,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      // At exact threshold, should still be ready since new dims are absent
      expect(result.ready).toBe(true);
    });

    test("batch sequential fallback should include all 7 score fields", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 4,
          verification_clarity: 5,
          completeness: 5,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      // batch disabled (default) → sequential fallback through evaluateTaskDepth
      const results = await batchEvaluateTaskDepth(
        [{ task, conventionsSummary: "conventions" }],
        undefined,
        {
          enabled: false,
          minBatchSize: 1,
          pollIntervalMs: 1000,
          maxWaitSeconds: 300,
          timeoutMs: 60000,
        },
      );

      expect(results.size).toBe(1);
      const result = results.get(task.id)!;
      expect(result.scores.implementationSpecificity).toBe(4);
      expect(result.scores.verificationClarity).toBe(5);
      expect(result.scores.completeness).toBe(5);
    });
  });

  describe("task-type-aware depth evaluation (TASK-092-C)", () => {
    test("should accept architecture responses without legacy code fields", async () => {
      const responseJson = {
        ready: true,
        overall_score: 3.7,
        scores: {
          decision_points: 4,
          alternatives_coverage: 3,
          adr_template_compliance: 4,
          cross_reference_completeness: 4,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask({
        tags: ["adr", "architecture"],
      });
      const result = await evaluateTaskDepth(task, "architecture conventions");

      expect(result.taskType).toBe(TaskType.Architecture);
      expect(result.threshold).toBe(3.5);
      expect(result.ready).toBe(true);
      expect(result.scores.decisionPoints).toBe(4);
      expect(result.scores.adrTemplateCompliance).toBe(4);
      expect(result.scores.clarity).toBeUndefined();
    });

    test("should let architecture tasks pass at 3.5", async () => {
      const responseJson = {
        ready: true,
        overall_score: 3.5,
        scores: {
          decision_points: 4,
          alternatives_coverage: 3,
          adr_template_compliance: 3,
          cross_reference_completeness: 3,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask({
        tags: ["architecture"],
      });
      const result = await evaluateTaskDepth(task, "architecture conventions");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(3.5);
    });

    test("should keep code tasks at the stricter 4.7 threshold", async () => {
      const responseJson = {
        ready: true,
        overall_score: 3.5,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask({
        tags: ["backend"],
      });
      const result = await evaluateTaskDepth(task, "code conventions");

      expect(result.taskType).toBe(TaskType.Code);
      expect(result.ready).toBe(false);
      expect(result.threshold).toBe(4.7);
    });

    test("should keep non-code tasks ready with an advisory when a task-type score is below 2 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.0,
        scores: {
          test_scope_definition: 4,
          target_coverage_areas: 4,
          infrastructure_references: 1,
          assertion_patterns: 4,
        },
        deficiencies: ["Infrastructure references are missing"],
        enrichment_suggestions: ["Name the fixtures and harness commands"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask({
        tags: ["playwright", "testing"],
      });
      const result = await evaluateTaskDepth(task, "test conventions");

      expect(result.taskType).toBe(TaskType.Test);
      expect(result.ready).toBe(true);
      expect(result.scores.infrastructureReferences).toBe(1);
      expect(
        result.deficiencies.some(
          (d) => d.startsWith("ADVISORY:") && d.includes("Infrastructure References"),
        ),
      ).toBe(true);
    });
  });

  describe("error handling", () => {
    test("should retry once on SDK error then throw", async () => {
      const fn = createErrorQueryFn("Connection timeout");
      _setQueryFn(fn);

      const task = makeValidTask();

      await expect(evaluateTaskDepth(task, "conventions summary")).rejects.toThrow(
        "Depth evaluation failed after 2 attempts",
      );
    });

    test("should succeed on second attempt after initial failure", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn, callCount } = createRetryQueryFn(1, "Temporary failure", responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.8);
      expect(callCount()).toBe(2);
    });

    test("should include original error message in thrown error", async () => {
      const fn = createErrorQueryFn("API rate limit exceeded");
      _setQueryFn(fn);

      const task = makeValidTask();

      await expect(evaluateTaskDepth(task, "conventions summary")).rejects.toThrow(
        "API rate limit exceeded",
      );
    });

    test("should timeout when SDK subprocess hangs (no messages emitted)", async () => {
      // Simulate a hanging SDK subprocess that never emits any messages.
      // The generator's next() never resolves — this is the exact failure mode
      // observed in production when Claude Code Max service is overloaded.
      const hangingFn: MockQueryFn = function () {
        return {
          next: () =>
            new Promise<IteratorResult<MockSDKMessage, void>>(() => {
              // Never resolves — simulates a hung subprocess
            }),
          return: () => Promise.resolve({ done: true as const, value: undefined }),
          throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };

      _setQueryFn(hangingFn);
      _setSdkTimeoutMs(500); // 500ms timeout for fast test

      const task = makeValidTask();

      try {
        // 2 retries × 500ms timeout each = ~1s total
        await expect(evaluateTaskDepth(task, "conventions summary")).rejects.toThrow("timed out");
      } finally {
        _setSdkTimeoutMs(undefined); // Reset to default
      }
    });

    test("should handle non-Error throws from SDK", async () => {
      // Simulate SDK throwing a non-Error value via a rejecting async generator
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

      const task = makeValidTask();

      await expect(evaluateTaskDepth(task, "conventions summary")).rejects.toThrow(
        "Depth evaluation failed after 2 attempts",
      );
    });
  });

  describe("seven-dimension evaluation (TASK-081)", () => {
    test("should parse all seven dimensions from LLM response", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 4,
          conventions: 5,
          implementation_specificity: 5,
          verification_clarity: 4,
          completeness: 5,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.8);
      expect(result.scores.clarity).toBe(5);
      expect(result.scores.scope).toBe(5);
      expect(result.scores.testability).toBe(4);
      expect(result.scores.conventions).toBe(5);
      expect(result.scores.implementationSpecificity).toBe(5);
      expect(result.scores.verificationClarity).toBe(4);
      expect(result.scores.completeness).toBe(5);
    });

    test("should handle old 4-dimension responses with backward compatibility", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          // No implementation_specificity, verification_clarity, or completeness
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.8);
      // New dimensions should default to old dimensions
      expect(result.scores.implementationSpecificity).toBe(5); // defaults to clarity
      expect(result.scores.verificationClarity).toBe(5); // defaults to testability
      expect(result.scores.completeness).toBe(5); // defaults to scope
    });

    test("should stay ready with a low-dimension advisory when implementationSpecificity is below 2 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 1,
          verification_clarity: 5,
          completeness: 5,
        },
        deficiencies: ["No file references or implementation detail"],
        enrichment_suggestions: ["Add file:line references"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.scores.implementationSpecificity).toBe(1);
      expect(
        result.deficiencies.some(
          (d) =>
            d.startsWith("ADVISORY:") &&
            d.includes("Implementation Specificity") &&
            d.includes("(< 2)"),
        ),
      ).toBe(true);
      expect(result.deficiencies).toContain("No file references or implementation detail");
    });

    test("should stay ready with a low-dimension advisory when verificationClarity is below 2 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 5,
          verification_clarity: 1,
          completeness: 5,
        },
        deficiencies: ["Success criteria not grep-verifiable"],
        enrichment_suggestions: ["Add specific patterns to check"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.scores.verificationClarity).toBe(1);
      expect(
        result.deficiencies.some(
          (d) => d.startsWith("ADVISORY:") && d.includes("Verification Clarity"),
        ),
      ).toBe(true);
    });

    test("should stay ready with a low-dimension advisory when completeness is below 2 (TASK-1300)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.8,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 5,
          conventions: 5,
          implementation_specificity: 5,
          verification_clarity: 5,
          completeness: 1,
        },
        deficiencies: ["Task describes backend and frontend but only has backend success criteria"],
        enrichment_suggestions: ["Add success criteria for all layers"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.scores.completeness).toBe(1);
      expect(
        result.deficiencies.some((d) => d.startsWith("ADVISORY:") && d.includes("Completeness")),
      ).toBe(true);
    });

    test("should return ready=false for old 4-dim response below 4.7 even with all scores >= 2", async () => {
      // Verifies that when new dims are absent, the overall threshold still applies.
      // Even though all individual scores are >= 2, overall 3.0 < 4.7 means NOT ready.
      const responseJson = {
        ready: true,
        overall_score: 3.0,
        scores: {
          clarity: 2,
          scope: 3,
          testability: 3,
          conventions: 3,
          // No implementation_specificity, verification_clarity, or completeness
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      // NOT ready — overall 3.0 < 4.7 threshold
      expect(result.ready).toBe(false);
      // New dims should have fallback values
      expect(result.scores.implementationSpecificity).toBe(2); // falls back to clarity=2
      expect(result.scores.verificationClarity).toBe(3); // falls back to testability=3
      expect(result.scores.completeness).toBe(3); // falls back to scope=3
    });

    test("should return ready=false for old 4-dim with overallScore 4.0 (below 4.7)", async () => {
      // Old format, overallScore: 4.0, undefined new dims — NOT ready because 4.0 < 4.7
      const responseJson = {
        ready: true,
        overall_score: 4.0,
        scores: {
          clarity: 4,
          scope: 4,
          testability: 4,
          conventions: 4,
        },
        deficiencies: [],
        enrichment_suggestions: [],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(false);
      expect(result.overallScore).toBe(4.0);
    });

    test("should return ready=true with all seven dimensions at threshold (overall=4.7, all scores>=2)", async () => {
      const responseJson = {
        ready: true,
        overall_score: 4.7,
        scores: {
          clarity: 5,
          scope: 5,
          testability: 4,
          conventions: 5,
          implementation_specificity: 4,
          verification_clarity: 5,
          completeness: 4,
        },
        deficiencies: [],
        enrichment_suggestions: ["Could improve in all dimensions"],
      };

      const { fn } = createMockQueryFn(responseJson);
      _setQueryFn(fn);

      const task = makeValidTask();
      const result = await evaluateTaskDepth(task, "conventions summary");

      expect(result.ready).toBe(true);
      expect(result.overallScore).toBe(4.7);
    });
  });
});

describe("fallback-resolved low dimensions (TASK-1300)", () => {
  test("a dimension resolved through its fallback key below 2 raises the advisory", async () => {
    const responseJson = {
      ready: true,
      overall_score: 4.8,
      // implementation_specificity omitted: it resolves from clarity (fallback).
      scores: { clarity: 1, scope: 5, testability: 5, conventions: 5 },
      deficiencies: [],
      enrichment_suggestions: [],
    };

    const { fn } = createMockQueryFn(responseJson);
    _setQueryFn(fn);

    const task = makeValidTask();
    const result = await evaluateTaskDepth(task, "conventions summary");

    expect(result.ready).toBe(true);
    expect(result.scores.implementationSpecificity).toBe(1);
    expect(
      result.deficiencies.some(
        (d) => d.startsWith("ADVISORY:") && d.includes("Implementation Specificity"),
      ),
    ).toBe(true);
    expect(
      result.deficiencies.some((d) => d.startsWith("ADVISORY:") && d.includes("Problem Clarity")),
    ).toBe(true);
  });
});
