import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, ParsedTask, VerificationResult } from "../../src/core/types";
import { TaskType } from "../../src/core/types";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";

const mockStructuredEvaluation = jest.fn();
jest.mock("../../src/llm/codex-structured-evaluator", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  runCodexStructuredEvaluation: (...args: unknown[]) => mockStructuredEvaluation(...args),
}));

const mockExecSync = jest.fn((command: string) => {
  if (command.includes("--name-only")) return "";
  return "diff --git a/src/game.ts b/src/game.ts\n+export const seeded = true;";
});
jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>("node:child_process"),
  execSync: (...args: unknown[]) => mockExecSync(String(args[0])),
}));

jest.mock("../../src/dispatcher/trusted-git", () => ({
  runTrustedGitSync: (args: readonly string[]) => mockExecSync(`git ${args.join(" ")}`),
}));

jest.mock("../../src/dispatcher/safe-semantic-file-reader", () => ({
  readContainedRegularFile: () => Promise.resolve("export const seeded = true;"),
}));

import {
  _setQueryFn as setBlueprintQueryFn,
  generateBlueprint,
} from "../../src/blueprint/blueprint-agent";
import { _setQueryFn as setJudgeQueryFn, runJudge } from "../../src/judge/llm-judge";
import { runPostJudgeVerification } from "../../src/dispatcher/post-judge-verifier";
import { runAdversarialVerification } from "../../src/dispatcher/lifecycle-manager";
import { evaluateTaskDepth } from "../../src/gate/depth-evaluator";
import { reviewSpecAmbiguity } from "../../src/preflight/spec-reviewer";

const evaluator = {
  runner: "codex-cli" as const,
  model: "gpt-5.6-terra",
  maxTurns: 30,
  timeoutMs: 600_000,
  codex: {
    binaryPath: "codex",
    sandbox: "read-only" as const,
    codexHome: "C:/Users/demo/.codex-headless",
    provider: "azure",
  },
};

function makeAdapter(evaluationProviders?: AdapterConfig["evaluationProviders"]): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "demo",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
      postJudge: {
        enabled: true,
        layers: ["semantic"],
        model: "claude-haiku-4-5-20251001",
        failOnBuildError: true,
        failOnTestError: true,
        failOnLintError: false,
        maxSemanticTokens: 8_000,
      },
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
    ...(evaluationProviders ? { evaluationProviders } : {}),
  };
  return {
    config,
    projectRoot: "C:/demo/worktree",
    conventionsDoc: "Keep the simulation deterministic.",
    judgeCriteria: "Prefer runtime evidence.",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

const task: ParsedTask = {
  id: "TASK-008",
  title: "Seeded randomness",
  priority: "P1-HIGH",
  effort: "3-4 hours",
  status: "READY",
  supersededBy: [],
  supersedes: [],
  relevanceReview: "",
  blockedBy: [],
  blocks: [],
  conventions: [],
  tags: [],
  problemStatement: "Runs cannot be replayed.",
  currentState: "Randomness is ambient.",
  recommendedApproach: "Inject a seeded generator.",
  filesToModify: [{ path: "src/game.ts", action: "Modify", notes: "Wire RNG" }],
  successCriteria: ["A supplied seed reproduces enemy spawns"],
  testingRequirements: ["Add a deterministic replay test"],
  contextReferences: [],
  rawContent: "# TASK-008",
};

const blueprint: Blueprint = {
  taskId: "TASK-008",
  fileAnalyses: [
    {
      filePath: "src/game.ts",
      action: "Modify",
      currentStructure: "Game loop",
      integrationPoints: "Constructor RNG dependency",
      patternToFollow: "src/game.ts:10",
    },
  ],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
  preconditions: [],
};

const verification: VerificationResult = {
  allPassed: true,
  commands: [],
  conventionChecks: [],
};

const emit = jest.fn();
const events = {
  emit,
} as unknown as IEventWriter;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  setBlueprintQueryFn(undefined);
  setJudgeQueryFn(undefined);
});

describe("Codex structured stage routing", () => {
  test("keeps evaluator providers absent by default and rejects writable evaluator sandboxes", () => {
    const base = makeAdapter().config;
    expect(AdapterConfigSchema.parse(base).evaluationProviders).toBeUndefined();
    const configured = AdapterConfigSchema.parse({
      ...base,
      evaluationProviders: {
        readinessDepth: evaluator,
        specReview: evaluator,
        lifecycleVerify: evaluator,
      },
    });
    expect(configured.evaluationProviders?.readinessDepth?.runner).toBe("codex-cli");
    expect(configured.evaluationProviders?.specReview?.runner).toBe("codex-cli");
    expect(configured.evaluationProviders?.lifecycleVerify?.runner).toBe("codex-cli");
    expect(() =>
      AdapterConfigSchema.parse({
        ...base,
        evaluationProviders: {
          judge: {
            runner: "codex-cli",
            codex: { sandbox: "workspace-write" },
          },
        },
      }),
    ).toThrow();
  });

  test("routes readiness depth through Codex and validates the stage result", async () => {
    const depthValue = {
      taskType: TaskType.Code,
      threshold: 4.7,
      ready: true,
      overallScore: 4.9,
      scores: {
        clarity: 5,
        scope: 5,
        testability: 5,
        conventions: 5,
        implementationSpecificity: 5,
        verificationClarity: 4,
        completeness: 5,
      },
      deficiencies: [],
      enrichmentSuggestions: [],
    };
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: depthValue,
      rawText: "{}",
      sessionId: "depth-session",
      turnsUsed: 1,
      durationMs: 1,
    });

    const result = await evaluateTaskDepth(task, "Keep it deterministic.", {
      evaluator,
      projectRoot: "C:/demo/worktree",
    });

    expect(result).toEqual(depthValue);
    const [requestArg, configArg] = mockStructuredEvaluation.mock.calls[0] as [
      {
        projectRoot: string;
        model: string;
        outputSchema: Record<string, unknown>;
        parse: (rawText: string) => unknown;
      },
      typeof evaluator,
    ];
    expect(requestArg.projectRoot).toBe("C:/demo/worktree");
    expect(requestArg.model).toBe("gpt-5.6-terra");
    expect(requestArg.outputSchema.type).toBe("object");
    expect(
      requestArg.parse(
        JSON.stringify({
          ready: true,
          overall_score: 4.9,
          scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
          deficiencies: [],
          enrichment_suggestions: [],
        }),
      ),
    ).toEqual(expect.objectContaining({ ready: true, overallScore: 4.9 }));
    expect(requestArg.parse("{}")).toBeNull();
    expect(configArg).toBe(evaluator);
  });

  test("retries and contains a failed Codex readiness evaluator", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "runner_error",
      errorKind: "parse_failed",
      message: "invalid depth result",
      durationMs: 1,
    });

    await expect(
      evaluateTaskDepth(task, "Keep it deterministic.", {
        evaluator,
        projectRoot: "C:/demo/worktree",
      }),
    ).rejects.toThrow("Depth evaluation failed after 2 attempts");
    expect(mockStructuredEvaluation).toHaveBeenCalledTimes(2);
  });

  test("routes preflight spec review through Codex and rejects invalid output", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: {
        ambiguityCount: 0,
        riskLevel: "low",
        findings: [],
        suggestedClarifications: [],
      },
      rawText: "{}",
      sessionId: "spec-review-session",
      turnsUsed: 1,
      durationMs: 1,
    });

    const result = await reviewSpecAmbiguity(task, {
      evaluator,
      projectRoot: "C:/demo/worktree",
    });

    expect(result.riskLevel).toBe("low");
    const [requestArg] = mockStructuredEvaluation.mock.calls[0] as [
      {
        projectRoot: string;
        model: string;
        outputSchema: Record<string, unknown>;
        parse: (rawText: string) => unknown;
      },
    ];
    expect(requestArg.projectRoot).toBe("C:/demo/worktree");
    expect(requestArg.model).toBe("gpt-5.6-terra");
    expect(requestArg.parse('{"findings":[],"suggestedClarifications":[]}')).toEqual({
      ambiguityCount: 0,
      riskLevel: "low",
      findings: [],
      suggestedClarifications: [],
    });
    expect(requestArg.parse('{"findings":[]}')).toBeNull();
    expect(requestArg.parse('{"findings":[{}],"suggestedClarifications":[]}')).toBeNull();
  });

  test("routes blueprint generation through the configured Codex evaluator", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: blueprint,
      rawText: JSON.stringify(blueprint),
      sessionId: "blueprint-session",
      turnsUsed: 1,
      durationMs: 1,
    });
    const result = await generateBlueprint(task, makeAdapter({ blueprint: evaluator }));
    expect(result.taskId).toBe("TASK-008");
    expect(result.fileAnalyses).toHaveLength(1);
    expect(result.producerProvenance).toEqual({
      runner: "codex-cli",
      provider: "azure",
      model: "gpt-5.6-terra",
    });
    const [requestArg, configArg] = mockStructuredEvaluation.mock.calls[0] as [
      { projectRoot: string; model: string; outputSchema: Record<string, unknown> },
      typeof evaluator,
    ];
    expect(requestArg.projectRoot).toBe("C:/demo/worktree");
    expect(requestArg.model).toBe("gpt-5.6-terra");
    expect(requestArg.outputSchema.type).toBe("object");
    expect(configArg).toBe(evaluator);
  });

  test("routes the main judge through Codex and preserves enforcement", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: {
        verdict: "APPROVE",
        confidence: 0.9,
        scopeViolations: [],
        criteriaGaps: [],
        qualityIssues: [],
        feedback: "Meets the contract.",
      },
      rawText: "{}",
      sessionId: "judge-session",
      turnsUsed: 1,
      durationMs: 1,
    });
    const result = await runJudge(
      {
        taskSpec: task.rawContent,
        gitDiff: "+seeded",
        verificationResults: verification,
      },
      makeAdapter({ judge: evaluator }),
    );
    expect(result.verdict).toBe("APPROVE");
    expect(result.claudeSessionId).toBe("judge-session");
    expect(result.judgmentTrace).toHaveLength(3);
  });

  test("routes semantic post-judge verification through Codex", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value: [
        {
          criterion: task.successCriteria[0],
          status: "pass",
          evidence: "Seed reaches the spawn generator.",
        },
      ],
      rawText: "{}",
      sessionId: "semantic-session",
      turnsUsed: 1,
      durationMs: 1,
    });
    const result = await runPostJudgeVerification(
      task.id,
      task,
      makeAdapter({ semanticPostJudge: evaluator }),
      "C:/demo/worktree",
      events,
    );
    expect(result.verified).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({ criterion: task.successCriteria[0], status: "pass" }),
    ]);
  });

  test("contains Codex semantic failure as a mandatory review finding", async () => {
    mockStructuredEvaluation.mockResolvedValue({
      status: "runner_error",
      errorKind: "parse_failed",
      message: "invalid findings",
      durationMs: 1,
    });
    const result = await runPostJudgeVerification(
      task.id,
      task,
      makeAdapter({ semanticPostJudge: evaluator }),
      "C:/demo/worktree",
      events,
    );
    expect(result.needsReview).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].status).toBe("fail");
    expect(result.findings[0].evidence).toContain("parse_failed");
  });

  test("routes post-approval lifecycle verification through Codex", async () => {
    const value = {
      passed: true,
      issues: [],
      criteriaResults: [
        {
          criterion: task.successCriteria[0],
          passed: true,
          evidence: "src/game.ts:42 passes the seed to the owned generator.",
        },
      ],
    };
    mockStructuredEvaluation.mockResolvedValue({
      status: "completed",
      value,
      rawText: JSON.stringify(value),
      sessionId: "lifecycle-session",
      turnsUsed: 1,
      durationMs: 1,
    });

    const result = await runAdversarialVerification(
      task.id,
      task,
      makeAdapter({ lifecycleVerify: evaluator }),
      "C:/demo/worktree",
      events,
    );

    expect(result).toEqual(value);
    const [requestArg, configArg] = mockStructuredEvaluation.mock.calls[0] as [
      {
        projectRoot: string;
        model: string;
        outputSchema: Record<string, unknown>;
        parse: (rawText: string) => unknown;
      },
      typeof evaluator,
    ];
    expect(requestArg.projectRoot).toBe("C:/demo/worktree");
    expect(requestArg.model).toBe("gpt-5.6-terra");
    expect(requestArg.parse(JSON.stringify(value))).toEqual(value);
    expect(requestArg.parse('{"passed":true,"issues":[],"criteriaResults":[]}')).toBeNull();
    expect(configArg).toBe(evaluator);
    expect(emit).toHaveBeenCalledWith(
      "lifecycle_verify_result",
      expect.objectContaining({ taskId: task.id, verified: true }),
    );
  });

  test("keeps Claude SDK as the blueprint default when no provider is configured", async () => {
    const query = async function* () {
      await Promise.resolve();
      yield { type: "result", subtype: "success", result: JSON.stringify(blueprint) };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    setBlueprintQueryFn(query as any);
    const result = await generateBlueprint(task, makeAdapter());
    expect(result.taskId).toBe("TASK-008");
    expect(result.producerProvenance).toEqual({
      runner: "claude-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });
});
