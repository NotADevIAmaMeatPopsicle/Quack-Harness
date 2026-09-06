// ─── Gate Tests ───────────────────────────────────────────────────────
// Tests for the readiness gate pipeline, including advisory override.

import type { ParsedTask, GateResult } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import type { GateAdvisory } from "../../src/analytics/analytics-types";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import type { EventPayload, EventStage } from "../../src/monitor/event-types";

// ─── Mocks ────────────────────────────────────────────────────────────

const mockValidateTaskSchema = jest.fn();
jest.mock("../../src/gate/schema-validator", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  validateTaskSchema: (...args: unknown[]) => mockValidateTaskSchema(...args),
}));

const mockEvaluateTaskDepth = jest.fn();
jest.mock("../../src/gate/depth-evaluator", () => ({
  evaluateTaskDepth: (...args: [ParsedTask, string, Record<string, unknown>?]) => {
    return mockEvaluateTaskDepth(...args) as Promise<unknown>;
  },
}));

const mockEnrichTask = jest.fn();
jest.mock("../../src/gate/enrichment-agent", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  enrichTask: (...args: unknown[]) => mockEnrichTask(...args),
}));

const mockGetGateAdvisory = jest.fn<GateAdvisory, [ParsedTask, string]>();
jest.mock("../../src/analytics/gate-advisor", () => ({
  getGateAdvisory: (...args: [ParsedTask, string]) => mockGetGateAdvisory(...args),
}));

const mockResolveModel = jest.fn().mockReturnValue("claude-haiku-4-5-20251001");
jest.mock("../../src/dispatcher/model-router", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  resolveModel: (...args: unknown[]) => mockResolveModel(...args),
}));

// ─── Import after mocking ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runReadinessGate } = require("../../src/gate/gate") as typeof import("../../src/gate/gate");

// ─── Helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
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
    problemStatement: "Test problem.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [{ path: "src/test.ts", action: "Modify", notes: "Test" }],
    successCriteria: ["Test criterion"],
    testingRequirements: ["Test requirement"],
    contextReferences: [],
    rawContent: "# TASK-042: Test Task\n\n## Metadata\n...",
    ...overrides,
  };
}

function makeAdapter(): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: { name: "test", root: ".", taskDir: "docs/tasks", conventionsDir: "docs" },
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
      autoCreatePr: true,
      autoPush: true,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
  };
  return {
    config,
    projectRoot: "/fake/project",
    conventionsDoc: "Test conventions.",
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

const defaultScores = { clarity: 4, scope: 4, testability: 4, conventions: 4 };

// ─── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: schema valid
  mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
  // Default: advisory with default threshold
  mockGetGateAdvisory.mockReturnValue({
    suggestedMinScore: 3.0,
    warnings: [],
    relevantPatterns: [],
  });
});

describe("runReadinessGate", () => {
  test("should pass when schema valid and depth ready", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    mockEvaluateTaskDepth.mockResolvedValue({
      ready: true,
      overallScore: 4.8,
      scores: defaultScores,
      deficiencies: [],
      enrichmentSuggestions: [],
    });

    const result = await runReadinessGate(task, adapter);
    expect(result.outcome).toBe("pass");
  });

  test("should reject when schema invalid", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    mockValidateTaskSchema.mockReturnValue({
      valid: false,
      missing: ["problemStatement"],
      warnings: [],
    });

    const result = await runReadinessGate(task, adapter);
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<GateResult, { outcome: "rejected" }>).reason).toContain(
      "Schema validation failed",
    );
  });

  test("should enrich when depth fails", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    mockEvaluateTaskDepth.mockResolvedValue({
      ready: false,
      overallScore: 2.5,
      scores: { clarity: 2, scope: 3, testability: 2, conventions: 3 },
      deficiencies: ["Missing implementation details"],
      enrichmentSuggestions: ["Add file paths"],
    });
    mockEnrichTask.mockResolvedValue("# TASK-042: Test Task\n\n## Enhanced content");

    const result = await runReadinessGate(task, adapter);
    expect(result.outcome).toBe("enriched");
  });

  test("should reject when depth fails and enrichment is skipped", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    mockEvaluateTaskDepth.mockResolvedValue({
      ready: false,
      overallScore: 2.5,
      scores: { clarity: 2, scope: 3, testability: 2, conventions: 3 },
      deficiencies: ["Missing details"],
      enrichmentSuggestions: [],
    });

    const result = await runReadinessGate(task, adapter, { skipEnrichment: true });
    expect(result.outcome).toBe("rejected");
    expect((result as Extract<GateResult, { outcome: "rejected" }>).reason).toContain(
      "Depth evaluation failed",
    );
  });

  test("should pass without depth evaluation when skipDepthOnly is true", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    const result = await runReadinessGate(task, adapter, { skipDepthOnly: true });

    expect(result.outcome).toBe("pass");
    expect(mockEvaluateTaskDepth).not.toHaveBeenCalled();
    expect(mockEnrichTask).not.toHaveBeenCalled();
  });

  test("should fall back to pass when enrichment fails and fallback is allowed", async () => {
    const task = makeTask();
    const adapter = makeAdapter();

    mockEvaluateTaskDepth.mockResolvedValue({
      ready: false,
      overallScore: 2.5,
      scores: { clarity: 2, scope: 3, testability: 2, conventions: 3 },
      deficiencies: ["Missing implementation details"],
      enrichmentSuggestions: ["Add file paths"],
    });
    mockEnrichTask.mockRejectedValue(new Error("Enrichment agent timed out after 1200s"));

    const result = await runReadinessGate(task, adapter, {
      allowEnrichmentFailureFallback: true,
    });

    expect(result.outcome).toBe("pass");
  });

  describe("advisory override", () => {
    test("should route to enrichment when depth passes but score < advisory suggestedMinScore", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      // Advisory recommends higher threshold based on failure history
      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 4.9,
        warnings: ["File src/test.ts has a 30% success rate"],
        relevantPatterns: [{ pattern: "file_hotspot:src/test.ts", suggestion: "Strengthen spec" }],
      });

      // Depth passes the hard threshold (4.7) but is below advisory (4.9)
      mockEvaluateTaskDepth.mockResolvedValue({
        ready: true,
        overallScore: 4.8,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: ["Some deficiencies"],
        enrichmentSuggestions: ["Add more detail"],
      });
      mockEnrichTask.mockResolvedValue("# TASK-042: Enriched content");

      const result = await runReadinessGate(task, adapter);

      // Should route to enrichment instead of passing
      expect(result.outcome).toBe("enriched");
      expect(mockEnrichTask).toHaveBeenCalled();
    });

    test("should pass when depth score meets advisory suggestedMinScore", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      // Advisory recommends 4.8
      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 4.8,
        warnings: [],
        relevantPatterns: [],
      });

      // Depth passes and meets the advisory threshold
      mockEvaluateTaskDepth.mockResolvedValue({
        ready: true,
        overallScore: 4.9,
        scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
        deficiencies: [],
        enrichmentSuggestions: [],
      });

      const result = await runReadinessGate(task, adapter);
      expect(result.outcome).toBe("pass");
    });

    test("should pass when advisory suggestedMinScore is default (3.0)", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      // Default advisory — no override
      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 3.0,
        warnings: [],
        relevantPatterns: [],
      });

      // Depth passes with score at 4.8
      mockEvaluateTaskDepth.mockResolvedValue({
        ready: true,
        overallScore: 4.8,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: [],
        enrichmentSuggestions: [],
      });

      const result = await runReadinessGate(task, adapter);
      // Should pass — advisory at 3.0 doesn't trigger override
      expect(result.outcome).toBe("pass");
    });

    test("should reject when depth fails and deficiencies contain BLOCKING keyword", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      mockEvaluateTaskDepth.mockResolvedValue({
        ready: false,
        overallScore: 3.5,
        scores: { clarity: 3, scope: 4, testability: 3, conventions: 4 },
        deficiencies: [
          "BLOCKING: Depends on TASK-097 (Health Assessment Engine) which does not exist yet",
          "Some non-blocking deficiency about test details",
        ],
        enrichmentSuggestions: ["Add more detail"],
      });

      const result = await runReadinessGate(task, adapter);
      expect(result.outcome).toBe("rejected");
      expect((result as Extract<GateResult, { outcome: "rejected" }>).reason).toContain(
        "Blocking deficiencies",
      );
      // Enrichment should NOT have been called
      expect(mockEnrichTask).not.toHaveBeenCalled();
    });

    test("should enrich when deficiencies exist but none are BLOCKING", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      mockEvaluateTaskDepth.mockResolvedValue({
        ready: false,
        overallScore: 3.5,
        scores: { clarity: 3, scope: 4, testability: 3, conventions: 4 },
        deficiencies: [
          "Missing implementation details for file paths",
          "Test coverage requirements unclear",
        ],
        enrichmentSuggestions: ["Add file paths"],
      });
      mockEnrichTask.mockResolvedValue("# TASK-042: Enriched content");

      const result = await runReadinessGate(task, adapter);
      expect(result.outcome).toBe("enriched");
      expect(mockEnrichTask).toHaveBeenCalled();
    });

    test("should reject when advisory override routes to enrichment but enrichment is skipped", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 4.9,
        warnings: ["Historical failures"],
        relevantPatterns: [],
      });

      mockEvaluateTaskDepth.mockResolvedValue({
        ready: true,
        overallScore: 4.8,
        scores: { clarity: 5, scope: 5, testability: 4, conventions: 5 },
        deficiencies: ["Some issues"],
        enrichmentSuggestions: [],
      });

      const result = await runReadinessGate(task, adapter, { skipEnrichment: true });
      // Should reject since enrichment is skipped
      expect(result.outcome).toBe("rejected");
    });
  });
});

describe("advisory pass-through (TASK-1300)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
    mockGetGateAdvisory.mockReturnValue({
      suggestedMinScore: 3.0,
      warnings: [],
      relevantPatterns: [],
    });
  });

  test("a ready result with ADVISORY deficiencies passes and carries them as advisories", async () => {
    mockEvaluateTaskDepth.mockResolvedValue({
      taskType: "code",
      threshold: 4.7,
      ready: true,
      overallScore: 4.8,
      scores: { ...defaultScores, testability: 1 },
      deficiencies: [
        'ADVISORY: dimension "Testability" scored 1 (< 2) — No test criteria',
        "Some plain informational deficiency",
      ],
      enrichmentSuggestions: [],
    });

    const result = await runReadinessGate(makeTask(), makeAdapter());

    expect(result.outcome).toBe("pass");
    const advisories = (result as Extract<GateResult, { outcome: "pass" }>).advisories;
    expect(advisories).toHaveLength(1);
    expect(advisories?.[0]).toContain("Testability");
  });

  test("artifact collision blockers ride the gate as advisories, never rejections", async () => {
    mockEvaluateTaskDepth.mockResolvedValue({
      taskType: "code",
      threshold: 4.7,
      ready: true,
      overallScore: 4.9,
      scores: defaultScores,
      deficiencies: [],
      enrichmentSuggestions: [],
    });

    const adapter = makeAdapter();
    adapter.adrDocs = { "035": "# ADR-035: Vapi voice integration" };
    const task = makeTask({
      rawContent: "# TASK-042\n\nCreate ADR-035 documenting the new gate advisory contract.",
    });

    const result = await runReadinessGate(task, adapter);

    expect(result.outcome).toBe("pass");
    const advisories = (result as Extract<GateResult, { outcome: "pass" }>).advisories;
    expect(advisories?.some((a) => a.startsWith("ADVISORY: artifact collision — ADR-035"))).toBe(
      true,
    );
  });

  test("skipDepthOnly pass still surfaces collision advisories", async () => {
    const adapter = makeAdapter();
    adapter.adrDocs = { "035": "# ADR-035: Vapi voice integration" };
    const task = makeTask({
      rawContent: "# TASK-042\n\nCreate ADR-035 for the new contract.",
    });

    const result = await runReadinessGate(task, adapter, { skipDepthOnly: true });

    expect(result.outcome).toBe("pass");
    expect(mockEvaluateTaskDepth).not.toHaveBeenCalled();
    const advisories = (result as Extract<GateResult, { outcome: "pass" }>).advisories;
    expect(advisories?.some((a) => a.includes("ADR-035"))).toBe(true);
  });
});

describe("judgment projection (TASK-1310)", () => {
  test("schema rejection keeps the legacy outcome and emits a safety decision", async () => {
    mockValidateTaskSchema.mockReturnValue({
      valid: false,
      missing: ["filesToModify"],
      warnings: [],
    });
    const emitted: Array<{ stage: EventStage; payload: EventPayload }> = [];
    const events: IEventWriter = {
      sessionId: "session",
      taskId: "TASK-042",
      project: "test",
      emit(stage, payload) {
        emitted.push({ stage, payload });
      },
      recordSession() {},
    };

    const result = await runReadinessGate(makeTask(), makeAdapter(), undefined, events);

    expect(result.outcome).toBe("rejected");
    expect(result.judgmentDecision?.action).toBe("stop");
    expect(result.judgmentDecision?.safetyFloor.blockers[0].safetyCode).toBe(
      "missing_required_schema",
    );
    expect(emitted.some((event) => event.stage === "gate_result")).toBe(true);
    expect(emitted.some((event) => event.stage === "judgment_decision")).toBe(true);
  });
});
