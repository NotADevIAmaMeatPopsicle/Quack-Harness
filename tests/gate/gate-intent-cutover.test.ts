// ─── Readiness intent cutover tests (TASK-1315) ─────────────────────
// The mode matrix, the safety pin, the never-orchestrated-pass pin,
// degradation preservation, and projection-failure containment.

import type { ParsedTask } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import type { GateAdvisory } from "../../src/analytics/analytics-types";
import type { IEventWriter } from "../../src/monitor/event-emitter";

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

// The intent runner: controllable per test; construction is COUNTED so
// the never-invoked pins are provable.
const mockRunnerRun = jest.fn();
const mockCreateRunner = jest.fn(() => ({
  kind: "claude-sdk" as const,
  run: (...args: unknown[]) => mockRunnerRun(...args) as Promise<unknown>,
}));
jest.mock("../../src/judgment/runner/intent-judgment-runner", () => ({
  createIntentJudgmentRunner: (...args: unknown[]) => mockCreateRunner(...(args as [])),
}));

// Projection override seam for the F7 containment test.
let projectionOverride: (() => never) | undefined;
jest.mock("../../src/judgment/judgment-adapters", () => {
  const actual = jest.requireActual<typeof import("../../src/judgment/judgment-adapters")>(
    "../../src/judgment/judgment-adapters",
  );
  return {
    ...actual,
    projectReadinessDecision: (...args: Parameters<typeof actual.projectReadinessDecision>) =>
      projectionOverride ? projectionOverride() : actual.projectReadinessDecision(...args),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runReadinessGate } = require("../../src/gate/gate") as typeof import("../../src/gate/gate");

const RAW_WITH_INTENT = [
  "# TASK-042: Test Task",
  "",
  "## Intent",
  "Honor the contract.",
  "",
  "## Problem Statement",
  "The problem.",
  "",
  "## Success Criteria",
  "- [ ] It works",
  "",
  "## Scope Boundaries",
  "- No adapter adoption",
].join("\n");

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
    rawContent: RAW_WITH_INTENT,
    ...overrides,
  };
}

function makeAdapter(readinessMode?: "off" | "shadow" | "enforce"): ProjectAdapter {
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
    ...(readinessMode
      ? {
          judgment: {
            runner: {
              provider: "claude-sdk" as const,
              model: "test-model",
              maxTurns: 5,
              timeoutMs: 1_000,
            },
            stages: {
              docsReview: { mode: "off" as const },
              readiness: { mode: readinessMode },
              loopBrief: { mode: "off" as const },
              loopDiff: { mode: "off" as const },
              judge: { mode: "off" as const },
            },
          },
        }
      : {}),
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

function recorder(): {
  events: Array<{ stage: string; payload: Record<string, unknown> }>;
  writer: IEventWriter;
} {
  const events: Array<{ stage: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    writer: {
      emit: (stage: string, payload: Record<string, unknown>) => events.push({ stage, payload }),
    } as unknown as IEventWriter,
  };
}

const defaultScores = { clarity: 4, scope: 4, testability: 4, conventions: 4 };

function depthReady(): void {
  mockEvaluateTaskDepth.mockResolvedValue({
    ready: true,
    overallScore: 4.8,
    scores: defaultScores,
    deficiencies: [],
    enrichmentSuggestions: [],
  });
}

function depthRejected(): void {
  mockEvaluateTaskDepth.mockResolvedValue({
    ready: false,
    overallScore: 3.1,
    scores: defaultScores,
    deficiencies: ["needs more detail"],
    enrichmentSuggestions: [],
  });
}

function completedRun(action: "continue" | "human_review", rationale: string[]): void {
  mockRunnerRun.mockImplementation((request: unknown) =>
    Promise.resolve({
      status: "completed",
      judgment: { source: "intent_model", action, rationale },
      consideredSignalRefs: (request as { signals: Array<{ ref: string }> }).signals.map(
        (signal) => signal.ref,
      ),
      model: "test-model",
      durationMs: 5,
      truncatedFields: [],
    }),
  );
}

function intentContinue(): void {
  completedRun("continue", ["spec is strong; deficiency is stylistic"]);
}

beforeEach(() => {
  jest.clearAllMocks();
  projectionOverride = undefined;
  mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
  mockGetGateAdvisory.mockReturnValue({
    suggestedMinScore: 3.0,
    warnings: [],
    relevantPatterns: [],
  });
});

describe("readiness intent cutover (TASK-1315)", () => {
  test("off mode is byte-identical: same result and same event sequence as an absent judgment key", async () => {
    depthReady();
    const control = recorder();
    const controlResult = await runReadinessGate(
      makeTask(),
      makeAdapter(),
      undefined,
      control.writer,
    );

    depthReady();
    const off = recorder();
    const offResult = await runReadinessGate(makeTask(), makeAdapter("off"), undefined, off.writer);

    expect(offResult).toEqual(controlResult);
    expect(off.events).toEqual(control.events);
    expect(mockCreateRunner).not.toHaveBeenCalled();
  });

  test("legacy PASSES are never orchestrated in any mode (runner not invoked)", async () => {
    for (const mode of ["shadow", "enforce"] as const) {
      jest.clearAllMocks();
      mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 3.0,
        warnings: [],
        relevantPatterns: [],
      });
      depthReady();
      const result = await runReadinessGate(makeTask(), makeAdapter(mode), {
        skipEnrichment: true,
      });
      expect(result.outcome).toBe("pass");
      expect(mockRunnerRun).not.toHaveBeenCalled();
      expect(result.judgmentOrchestration?.reason).toBe("no_blocking_signals");
    }
  });

  test("shadow computes and attaches but NEVER changes the outcome on a depth rejection", async () => {
    depthRejected();
    intentContinue();
    const { events, writer } = recorder();
    const result = await runReadinessGate(
      makeTask(),
      makeAdapter("shadow"),
      { skipEnrichment: true },
      writer,
    );

    expect(result.outcome).toBe("rejected");
    expect(result.judgmentOrchestration?.attempted).toBe(true);
    expect(result.judgmentOrchestration?.diverged).toBe(true);
    expect(events.some((e) => e.stage === "judgment_evaluation")).toBe(true);
    const gateResults = events.filter((e) => e.stage === "gate_result");
    expect(gateResults).toHaveLength(1);
    expect(gateResults[0].payload.outcome).toBe("rejected");
  });

  test("enforce: intent continue RESCUES a depth rejection to pass with the rationale visible", async () => {
    depthRejected();
    intentContinue();
    const { events, writer } = recorder();
    const result = await runReadinessGate(
      makeTask(),
      makeAdapter("enforce"),
      { skipEnrichment: true },
      writer,
    );

    expect(result.outcome).toBe("pass");
    if (result.outcome === "pass") {
      expect(result.advisories?.some((a) => a.startsWith("INTENT RESCUE:"))).toBe(true);
    }
    const gateResults = events.filter((e) => e.stage === "gate_result");
    expect(gateResults).toHaveLength(1);
    expect(gateResults[0].payload).toEqual({ outcome: "pass", intentRescue: true });
    const finals = events.filter((e) => e.stage === "judgment_decision");
    expect(finals).toHaveLength(1);
  });

  test("enforce: intent human_review CONFIRMS the rejection with the rationale appended", async () => {
    depthRejected();
    completedRun("human_review", ["spec is genuinely thin"]);
    const result = await runReadinessGate(makeTask(), makeAdapter("enforce"), {
      skipEnrichment: true,
    });

    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("intent:");
      expect(result.reason).toContain("genuinely thin");
    }
  });

  test("SAFETY PIN: schema-invalid tasks stay rejected in enforce and the runner is never invoked", async () => {
    mockValidateTaskSchema.mockReturnValue({ valid: false, missing: ["Intent"], warnings: [] });
    intentContinue();
    const result = await runReadinessGate(makeTask(), makeAdapter("enforce"));

    expect(result.outcome).toBe("rejected");
    expect(mockRunnerRun).not.toHaveBeenCalled();
    expect(result.judgmentOrchestration?.reason).toBe("safety_stop");
  });

  test("enforce degradation preserves the LEGACY outcome (preserve_legacy posture)", async () => {
    depthRejected();
    mockRunnerRun.mockResolvedValue({
      status: "runner_error",
      errorCode: "timeout",
      message: "timed out",
      model: "test-model",
      durationMs: 5,
      truncatedFields: [],
    });
    const result = await runReadinessGate(makeTask(), makeAdapter("enforce"), {
      skipEnrichment: true,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.judgmentOrchestration?.reason).toBe("enforce_runner_error_legacy_preserved");
    expect(result.judgmentDecision).toEqual(result.judgmentOrchestration?.legacyDecision);
  });

  test("no intent sections: orchestration skips with intent_context_unavailable and legacy stands", async () => {
    depthRejected();
    const result = await runReadinessGate(
      makeTask({ rawContent: "# TASK-042\n\nno canonical sections here" }),
      makeAdapter("enforce"),
      { skipEnrichment: true },
    );
    expect(result.outcome).toBe("rejected");
    expect(mockRunnerRun).not.toHaveBeenCalled();
    expect(result.judgmentOrchestration?.reason).toBe("intent_context_unavailable");
  });

  test("F7: a THROWING projection is contained fail-closed in enforce — outcome preserved, runner never invoked", async () => {
    depthRejected();
    intentContinue();
    projectionOverride = () => {
      throw new Error("projection exploded");
    };
    const { events, writer } = recorder();
    const result = await runReadinessGate(
      makeTask(),
      makeAdapter("enforce"),
      { skipEnrichment: true },
      writer,
    );

    expect(result.outcome).toBe("rejected");
    expect(mockRunnerRun).not.toHaveBeenCalled();
    expect(result.judgmentDecision?.action).toBe("human_review");
    expect(result.judgmentDecision?.judgment.rationale).toContain("judgment_projection_failure");
    expect(result.judgmentOrchestration?.reason).toBe("projection_failure");
    expect(events.some((e) => e.stage === "judgment_projection_failed")).toBe(true);
  });

  test("off byte-identity holds on REJECTED and ENRICHED terminals too (r2-F5)", async () => {
    for (const setup of ["rejected", "enriched"] as const) {
      jest.clearAllMocks();
      projectionOverride = undefined;
      mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
      mockGetGateAdvisory.mockReturnValue({
        suggestedMinScore: 3.0,
        warnings: [],
        relevantPatterns: [],
      });
      depthRejected();
      if (setup === "enriched") {
        mockEnrichTask.mockResolvedValue("# TASK-042: enriched");
      }
      const options = setup === "rejected" ? { skipEnrichment: true } : undefined;

      const control = recorder();
      const controlResult = await runReadinessGate(
        makeTask(),
        makeAdapter(),
        options,
        control.writer,
      );

      depthRejected();
      if (setup === "enriched") {
        mockEnrichTask.mockResolvedValue("# TASK-042: enriched");
      }
      const off = recorder();
      const offResult = await runReadinessGate(makeTask(), makeAdapter("off"), options, off.writer);

      expect(offResult).toEqual(controlResult);
      expect(off.events).toEqual(control.events);
    }
  });

  test("degradation deep-equals the legacy result in BOTH modes across every error code (r2-F2/F5)", async () => {
    for (const mode of ["shadow", "enforce"] as const) {
      for (const errorCode of [
        "timeout",
        "sdk_error",
        "invalid_output",
        "no_result",
        "aborted",
      ] as const) {
        jest.clearAllMocks();
        projectionOverride = undefined;
        mockValidateTaskSchema.mockReturnValue({ valid: true, missing: [], warnings: [] });
        mockGetGateAdvisory.mockReturnValue({
          suggestedMinScore: 3.0,
          warnings: [],
          relevantPatterns: [],
        });
        depthRejected();
        mockRunnerRun.mockResolvedValue({
          status: "runner_error",
          errorCode,
          message: "degraded",
          model: "test-model",
          durationMs: 5,
          truncatedFields: [],
        });
        const { events, writer } = recorder();
        const result = await runReadinessGate(
          makeTask(),
          makeAdapter(mode),
          { skipEnrichment: true },
          writer,
        );

        expect(result.outcome).toBe("rejected");
        if (result.outcome === "rejected") {
          // r2-F2: NO intent text is appended on degradation.
          expect(result.reason).toBe("Depth evaluation failed");
        }
        expect(result.judgmentDecision).toEqual(result.judgmentOrchestration?.legacyDecision);
        // The emitted gate_result matches the untouched legacy payload.
        const gateResults = events.filter((e) => e.stage === "gate_result");
        expect(gateResults).toHaveLength(1);
        expect(gateResults[0].payload).toEqual({
          outcome: "rejected",
          reason: "Depth evaluation failed",
        });
      }
    }
  });

  test("confirmed rejection emits the FINAL reason on gate_result (r2-F3)", async () => {
    depthRejected();
    completedRun("human_review", ["spec is genuinely thin"]);
    const { events, writer } = recorder();
    const result = await runReadinessGate(
      makeTask(),
      makeAdapter("enforce"),
      { skipEnrichment: true },
      writer,
    );

    expect(result.outcome).toBe("rejected");
    const gateResults = events.filter((e) => e.stage === "gate_result");
    expect(gateResults).toHaveLength(1);
    if (result.outcome === "rejected") {
      expect(gateResults[0].payload).toEqual({
        outcome: "rejected",
        reason: result.reason,
        intentConfirmedRejection: true,
      });
      expect(result.reason).toContain("genuinely thin");
    }
  });

  test("rescue KEEPS deterministic ADVISORY findings (r2-F4)", async () => {
    mockEvaluateTaskDepth.mockResolvedValue({
      ready: false,
      overallScore: 3.1,
      scores: defaultScores,
      deficiencies: ["ADVISORY: collides with TASK-041", "needs more detail"],
      enrichmentSuggestions: [],
    });
    intentContinue();
    const result = await runReadinessGate(makeTask(), makeAdapter("enforce"), {
      skipEnrichment: true,
    });

    expect(result.outcome).toBe("pass");
    if (result.outcome === "pass") {
      expect(result.advisories).toEqual([
        "ADVISORY: collides with TASK-041",
        expect.stringContaining("INTENT RESCUE:"),
      ]);
    }
  });

  test("judgment_evaluation is NOT emitted on skip reasons (r2-F3)", async () => {
    depthRejected();
    const { events, writer } = recorder();
    // No intent sections -> intent_context_unavailable (attempted false).
    await runReadinessGate(
      makeTask({ rawContent: "# TASK-042" }),
      makeAdapter("enforce"),
      { skipEnrichment: true },
      writer,
    );
    expect(events.some((e) => e.stage === "judgment_evaluation")).toBe(false);
  });

  test("enriched outcomes SKIP orchestration (legacy decision active)", async () => {
    depthRejected();
    mockEnrichTask.mockResolvedValue("# TASK-042: enriched content");
    intentContinue();
    const result = await runReadinessGate(makeTask(), makeAdapter("enforce"));

    expect(result.outcome).toBe("enriched");
    expect(mockRunnerRun).not.toHaveBeenCalled();
    expect(result.judgmentOrchestration).toBeUndefined();
    expect(result.judgmentDecision?.action).toBe("human_review");
  });
});
