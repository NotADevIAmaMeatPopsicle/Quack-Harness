import type { IntentJudgmentRequest, JudgmentStage } from "../../src/judgment/judgment-types";

const mockStructuredEvaluation = jest.fn();
jest.mock("../../src/llm/codex-structured-evaluator", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  runCodexStructuredEvaluation: (...args: unknown[]) => mockStructuredEvaluation(...args),
}));

import { createIntentJudgmentRunner } from "../../src/judgment/runner/intent-judgment-runner";
import { orchestrateJudgment } from "../../src/judgment/judgment-orchestrator";
import { reduceJudgment } from "../../src/judgment/judgment-reducer";

const stages: JudgmentStage[] = ["docs_review", "readiness", "loop_brief", "loop_diff", "judge"];

const config = {
  provider: "codex-cli" as const,
  model: "gpt-5.6-terra",
  maxTurns: 5,
  timeoutMs: 120_000,
  codex: {
    binaryPath: "codex",
    sandbox: "read-only" as const,
    codexHome: "C:/Users/demo/.codex-headless",
    profile: "headless",
    provider: "azure",
  },
};

function request(stage: JudgmentStage): IntentJudgmentRequest {
  return {
    stage,
    taskId: "TASK-008",
    taskIntent: "Preserve deterministic game behavior.",
    successCriteria: ["Replay output is stable"],
    scopeBoundaries: ["No production deployment"],
    stageContext: { verdict: "review" },
    signals: [
      {
        ref: "intent_gap#1",
        signal: {
          source: stage,
          code: "intent_gap",
          disposition: "human_review",
          message: "Review intent coverage",
          deterministic: true,
        },
      },
    ],
    contextMetadata: { presentSections: ["Intent"], missingSections: [] },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Codex intent judgment runner", () => {
  it.each(stages)("uses the exact typed contract for the %s cutover", async (stage) => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: {
        action: "continue",
        rationale: ["Intent is satisfied"],
        consideredSignalRefs: ["intent_gap#1"],
      },
      rawText: "{}",
      sessionId: `codex-${stage}`,
      turnsUsed: 1,
      durationMs: 7,
    });
    const runner = createIntentJudgmentRunner(config, "C:/demo/worktree");

    const result = await runner.run(request(stage));

    expect(runner.kind).toBe("codex-cli");
    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        model: "gpt-5.6-terra",
        sessionId: `codex-${stage}`,
        consideredSignalRefs: ["intent_gap#1"],
        judgment: {
          source: "intent_model",
          action: "continue",
          rationale: ["Intent is satisfied"],
        },
      }),
    );
    const [evaluationRequest, evaluatorConfig] = mockStructuredEvaluation.mock.calls[0] as [
      {
        projectRoot: string;
        model: string;
        systemPrompt: string;
        prompt: string;
        outputSchema: Record<string, unknown>;
        parse: (rawText: string) => unknown;
      },
      Record<string, unknown>,
    ];
    expect(evaluationRequest.projectRoot).toBe("C:/demo/worktree");
    expect(evaluationRequest.model).toBe("gpt-5.6-terra");
    expect(evaluationRequest.systemPrompt).toContain("intent-reading judgment gate");
    expect(evaluationRequest.prompt).toContain(`"stage":"${stage}"`);
    expect(evaluationRequest.outputSchema).toEqual(
      expect.objectContaining({
        type: "object",
        additionalProperties: false,
      }),
    );
    expect(evaluatorConfig.runner).toBe("codex-cli");
    expect(evaluatorConfig.timeoutMs).toBe(120_000);
    const codexConfig = evaluatorConfig.codex as Record<string, unknown>;
    expect(codexConfig).toEqual({
      binaryPath: "codex",
      sandbox: "read-only",
      provider: "azure",
      profile: "headless",
      codexHome: "C:/Users/demo/.codex-headless",
    });
    expect(
      evaluationRequest.parse(
        JSON.stringify({
          action: "continue",
          rationale: ["Intent is satisfied"],
          consideredSignalRefs: ["intent_gap#1"],
        }),
      ),
    ).toEqual(expect.objectContaining({ action: "continue" }));
    expect(
      evaluationRequest.parse(
        JSON.stringify({
          action: "continue",
          rationale: ["Ignored the signal"],
          consideredSignalRefs: [],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["timeout", "timeout", "timeout"],
    ["parse_failed", "bad output", "invalid_output"],
    ["parse_failed", "produced no structured last message", "no_result"],
    ["tree_mutated", "read-only evaluator changed the worktree", "sdk_error"],
  ])("maps %s failures into existing %s degradation", async (errorKind, message, errorCode) => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "runner_error",
      errorKind,
      message,
      durationMs: 9,
    });

    const result = await createIntentJudgmentRunner(config, "C:/demo/worktree").run(
      request("docs_review"),
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "runner_error",
        errorCode,
        model: "gpt-5.6-terra",
      }),
    );
  });

  it("preserves shadow and enforce orchestration semantics with the Codex runner", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "runner_error",
      errorKind: "timeout",
      message: "timed out",
      durationMs: 9,
    });
    const stageRequest = request("docs_review");
    const legacy = reduceJudgment({
      stage: "docs_review",
      signals: stageRequest.signals.map((entry) => entry.signal),
      judgment: {
        source: "legacy_policy",
        action: "human_review",
        rationale: ["legacy"],
      },
    });
    const runner = createIntentJudgmentRunner(config, "C:/demo/worktree");

    const shadow = await orchestrateJudgment({
      mode: "shadow",
      legacyDecision: legacy,
      request: stageRequest,
      runner,
    });
    const enforce = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request: stageRequest,
      runner,
    });
    const preserved = await orchestrateJudgment({
      mode: "enforce",
      legacyDecision: legacy,
      request: stageRequest,
      runner,
      onRunnerError: "preserve_legacy",
    });

    expect(shadow.reason).toBe("shadow_runner_error");
    expect(shadow.activeDecision).toEqual(legacy);
    expect(enforce.reason).toBe("enforce_runner_error");
    expect(enforce.activeDecision.action).toBe("human_review");
    expect(preserved.reason).toBe("enforce_runner_error_legacy_preserved");
    expect(preserved.activeDecision).toEqual(legacy);
  });
});
