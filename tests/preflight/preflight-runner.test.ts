import { QuackRuntimeError } from "../../src/core/runtime-errors";
import { QuackDB } from "../../src/db";
import { blueprintFailure } from "../../src/blueprint/generation-failure";
import { parseFullPreflightResult } from "../../src/monitor/preflight-job-result";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type {
  AdapterConfig,
  ContextSizeEstimate,
  GateResult,
  ParsedTask,
  TaskContext,
} from "../../src/core/types";
import { TaskType } from "../../src/core/types";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import type { SubtaskPlan } from "../../src/preflight/decompose-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import type { SpecReviewResult } from "../../src/preflight/spec-review-types";

const mockRunReadinessGate = jest.fn<
  Promise<GateResult>,
  [ParsedTask, ProjectAdapter, unknown?, unknown?]
>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (...args: [ParsedTask, ProjectAdapter, unknown?, unknown?]) =>
    mockRunReadinessGate(...args),
}));

const mockBlueprint: Blueprint = {
  taskId: "TASK-099",
  fileAnalyses: [
    {
      filePath: "src/a.ts",
      action: "Modify",
      currentStructure: "class A",
      integrationPoints: "line 10",
      patternToFollow: "export class",
    },
  ],
  codeExamples: [{ file: "src/a.ts", description: "Example", before: "old", after: "new" }],
  verificationPatterns: [
    { criterion: "c1", checkType: "grep", pattern: "export", fileGlob: "src/**" },
  ],
  antiPatterns: ["Don't do X"],
  preconditions: [],
};

const mockGenerateBlueprint = jest.fn<Promise<Blueprint>, [ParsedTask, ProjectAdapter]>();
mockGenerateBlueprint.mockResolvedValue(mockBlueprint);
jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: (...args: [ParsedTask, ProjectAdapter]) => mockGenerateBlueprint(...args),
}));

const mockFormatBlueprintForPrompt = jest.fn<string, [Blueprint]>();
mockFormatBlueprintForPrompt.mockReturnValue("## Blueprint\n\nFormatted blueprint content");
jest.mock("../../src/blueprint/blueprint-prompt", () => ({
  formatBlueprintForPrompt: (...args: [Blueprint]) => mockFormatBlueprintForPrompt(...args),
}));

const mockContextSizeEstimate: ContextSizeEstimate = {
  taskSpec: 500,
  blueprint: 1000,
  repoMap: 800,
  relevantFiles: 2000,
  relatedPatterns: 300,
  existingTests: 700,
  conventions: 400,
  claudeMd: 300,
  total: 6000,
  withinBudget: true,
};

const mockContext: TaskContext = {
  taskSpec: "task spec",
  conventions: { "conv.md": "conventions" },
  conventionsSummary: "summary",
  relevantFiles: ["file1.ts"],
  relatedPatterns: [],
  existingTests: [],
  claudeMd: [],
  contextSizeEstimate: mockContextSizeEstimate,
};

const mockAssembleContext = jest.fn<Promise<TaskContext>, [ParsedTask, ProjectAdapter, string?]>();
mockAssembleContext.mockResolvedValue(mockContext);
jest.mock("../../src/dispatcher/context-assembler", () => ({
  assembleContext: (...args: [ParsedTask, ProjectAdapter, string?]) => mockAssembleContext(...args),
}));

const mockReviewSpecAmbiguity = jest.fn<Promise<SpecReviewResult>, [ParsedTask, unknown?]>();
mockReviewSpecAmbiguity.mockResolvedValue({
  ambiguityCount: 0,
  riskLevel: "low",
  findings: [],
  suggestedClarifications: [],
});
jest.mock("../../src/preflight/spec-reviewer", () => ({
  reviewSpecAmbiguity: (...args: [ParsedTask, unknown?]) => mockReviewSpecAmbiguity(...args),
}));

const mockDecomposeTask = jest.fn<
  Promise<SubtaskPlan>,
  [ParsedTask, ProjectAdapter, Blueprint, { maxSubtasks?: number }?]
>();
jest.mock("../../src/preflight/task-decomposer", () => ({
  decomposeTask: (...args: [ParsedTask, ProjectAdapter, Blueprint, { maxSubtasks?: number }?]) =>
    mockDecomposeTask(...args),
}));

const mockWriteSubtaskSpecs = jest.fn<
  Promise<string[]>,
  [SubtaskPlan, ParsedTask, ProjectAdapter]
>();
jest.mock("../../src/preflight/subtask-writer", () => ({
  writeSubtaskSpecs: (...args: [SubtaskPlan, ParsedTask, ProjectAdapter]) =>
    mockWriteSubtaskSpecs(...args),
}));

import { runPreflight } from "../../src/preflight/preflight-runner";
import { PrepCache } from "../../src/monitor/prep-cache";

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const task: ParsedTask = {
    id: "TASK-099",
    title: "Test task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [
      { path: "src/a.ts", action: "Modify", notes: "" },
      { path: "src/b.ts", action: "Modify", notes: "" },
    ],
    successCriteria: ["criterion 1", "criterion 2"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-099\n\nTest task content",
    ...overrides,
  };
  return {
    ...task,
    supersededBy: task.supersededBy ?? [],
    supersedes: task.supersedes ?? [],
    relevanceReview: task.relevanceReview ?? "",
  };
}

function makeAdapter(tmpDir: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "test-project",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "test", command: "npm test", required: true, timeout: 60000 }],
      conventionChecks: [],
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
      commitTrailer: "",
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
    projectRoot: tmpDir,
    conventionsDoc: "Test conventions",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    config,
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function makeEventWriter(events: Array<{ stage: string; payload: unknown }>): IEventWriter {
  return {
    sessionId: "session-test",
    taskId: "TASK-099",
    project: "test-project",
    emit(stage, payload) {
      events.push({ stage, payload });
    },
    recordSession() {
      // no-op for tests
    },
  };
}

describe("runPreflight", () => {
  let tmpDir: string;
  let adapter: ProjectAdapter;
  let task: ParsedTask;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-preflight-"));
    adapter = makeAdapter(tmpDir);
    task = makeTask();

    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, "TASK-099.md"), task.rawContent);
    await fs.mkdir(path.join(tmpDir, ".quack", "prep"), { recursive: true });

    mockRunReadinessGate.mockReset();
    mockGenerateBlueprint.mockReset();
    mockFormatBlueprintForPrompt.mockReset();
    mockAssembleContext.mockReset();
    mockReviewSpecAmbiguity.mockReset();
    mockDecomposeTask.mockReset();
    mockWriteSubtaskSpecs.mockReset();

    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task,
    });
    mockGenerateBlueprint.mockResolvedValue(mockBlueprint);
    mockFormatBlueprintForPrompt.mockReturnValue("## Blueprint\n\nFormatted blueprint content");
    mockAssembleContext.mockResolvedValue(mockContext);
    mockReviewSpecAmbiguity.mockResolvedValue({
      ambiguityCount: 0,
      riskLevel: "low",
      findings: [],
      suggestedClarifications: [],
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("produces a complete PreflightResult", async () => {
    const result: PreflightResult = await runPreflight(task, adapter, { force: true });

    expect(result.taskId).toBe("TASK-099");
    expect(result.timestamp).toBeDefined();
    expect(result.contentHash).toBeDefined();
    expect(typeof result.contentHash).toBe("string");
    expect(result.contentHash.length).toBe(64);
    expect(result.gate.ready).toBe(true);
    expect(result.blueprint.fileAnalyses).toBe(1);
    expect(result.blueprint.codeExamples).toBe(1);
    expect(result.blueprint.verificationPatterns).toBe(1);
    expect(result.blueprint.antiPatterns).toBe(1);
    expect(result.blueprint.formattedMarkdown).toContain("Blueprint");
    expect(result.contextEstimate.total).toBe(6000);
    expect(result.contextEstimate.withinBudget).toBe(true);
    expect(result.complexity.filesToModify).toBe(2);
    expect(result.complexity.successCriteria).toBe(2);
    expect(result.complexity.recommendDecomposition).toBe(false);
  });

  it.each(["requested", "fallback"])("configured schema rejection survives %s deterministic preflight", async (entry) => {
    task = makeTask({ filesToModify: [], testingRequirements: ["Test required schema"] });
    adapter.config.gate = { requiredSections: ["filesToModify"] };
    if (entry === "fallback") mockRunReadinessGate.mockRejectedValue(new Error("runtime unavailable"));
    const result = await runPreflight(task, adapter, { force: true, ...(entry === "requested" ? { mode: "deterministic" as const } : {}) });
    expect(result.gate).toMatchObject({ ready: false, score: 0,
      reason: "Schema validation failed", schemaErrors: ["files_to_modify (required by project config)"] });
    const cached = await new PrepCache(tmpDir).readPreflight(task.id, result.contentHash);
    expect(cached?.gate).toEqual(result.gate);
  });

  it("invalidates cached preflight when required sections change but task content does not", async () => {
    task = makeTask({ filesToModify: [], testingRequirements: ["Exercise schema policy"] });
    adapter.config.gate = { requiredSections: [] };
    const prior = await runPreflight(task, adapter, { force: true });
    expect(prior.gate.ready).toBe(true);
    adapter.config.gate = { requiredSections: ["filesToModify"] };
    const current = await runPreflight(task, adapter, { mode: "deterministic" });
    expect(current.contentHash).toBe(prior.contentHash);
    expect(current.gate).toMatchObject({
      ready: false, score: 0,
      schemaErrors: ["files_to_modify (required by project config)"],
    });
  });

  it("does not treat an unstamped legacy cache as default-policy evidence", async () => {
    task = makeTask({ testingRequirements: ["Exercise legacy policy"] });
    adapter.config.gate = { requiredSections: [] };
    const prior = await runPreflight(task, adapter, { force: true });
    expect(prior.gate.score).toBe(5);
    const legacy = { ...prior } as PreflightResult & { schemaPolicyHash?: string };
    delete legacy.schemaPolicyHash;
    await new PrepCache(tmpDir).writePreflight(legacy);
    const current = await runPreflight(task, adapter, { mode: "deterministic" });
    expect(current.contentHash).toBe(prior.contentHash);
    expect(current.gate.score).toBe(3);
  });

  it("retains full schema rejection diagnostics without inventing them for depth or pass", async () => {
    mockRunReadinessGate.mockResolvedValue({ outcome: "rejected", reason: "Schema validation failed",
      details: { valid: false, missing: ["configured field"], warnings: [] } });
    const schema = await runPreflight(task, adapter, { force: true });
    expect(schema.gate).toMatchObject({ reason: "Schema validation failed", schemaErrors: ["configured field"] });
    expect((await new PrepCache(tmpDir).readPreflight(task.id, schema.contentHash))?.gate).toEqual(schema.gate);
    mockRunReadinessGate.mockResolvedValue({ outcome: "rejected", reason: "Depth evidence too thin",
      details: { ready: false, overallScore: 3, scores: {}, deficiencies: ["thin"] } } as GateResult);
    const depth = await runPreflight(task, adapter, { force: true });
    expect(depth.gate).toMatchObject({ reason: "Depth evidence too thin" });
    expect(depth.gate).not.toHaveProperty("schemaErrors");
    mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task });
    const passed = await runPreflight(task, adapter, { force: true });
    const skipped = await runPreflight(task, adapter, { force: true, skipGate: true });
    for (const result of [passed, skipped]) {
      expect(result.gate).not.toHaveProperty("reason");
      expect(result.gate).not.toHaveProperty("schemaErrors");
    }
  });

  it("valid configured deterministic tasks retain score three without failure diagnostics", async () => {
    task = makeTask({ testingRequirements: ["Test required schema"] });
    adapter.config.gate = { requiredSections: ["filesToModify"] };
    const result = await runPreflight(task, adapter, { force: true, mode: "deterministic" });
    expect(parseFullPreflightResult(result)).toEqual(result);
    expect(result.gate).toMatchObject({ ready: true, score: 3 });
    expect(result.gate).not.toHaveProperty("reason");
    expect(result.gate).not.toHaveProperty("schemaErrors");
  });

  it("surfaces ADVISORY gate findings on the result (TASK-1300)", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task,
      advisories: [
        'ADVISORY: dimension "Testability" scored 1 (< 2) — No test criteria specified',
        "ADVISORY: artifact collision — ADR-035: Use ADR-047 instead.",
      ],
    });

    const result: PreflightResult = await runPreflight(task, adapter, { force: true });

    expect(result.gate.ready).toBe(true);
    expect(result.gate.advisories).toHaveLength(2);
    expect(result.gate.advisories?.[0]).toContain("Testability");
    expect(result.gate.advisories?.[1]).toContain("artifact collision");
  });

  it("omits the advisories field when the gate has none", async () => {
    const result: PreflightResult = await runPreflight(task, adapter, { force: true });
    expect(result.gate.advisories).toBeUndefined();
  });

  it("calls gate, blueprint, context assembly in sequence", async () => {
    await runPreflight(task, adapter, { force: true });

    expect(mockRunReadinessGate).toHaveBeenCalledWith(
      task,
      { ...adapter, config: { ...adapter.config, gate: { requiredSections: [] } } },
      { skipEnrichment: true },
      undefined,
    );
    expect(mockGenerateBlueprint).toHaveBeenCalledWith(task, adapter);
    expect(mockFormatBlueprintForPrompt).toHaveBeenCalledWith(mockBlueprint);
    expect(mockAssembleContext).toHaveBeenCalledWith(
      task,
      adapter,
      "## Blueprint\n\nFormatted blueprint content",
    );
  });

  it("forwards the explicit Codex spec-review provider in the normal preflight path", async () => {
    const evaluator = {
      runner: "codex-cli" as const,
      model: "gpt-5.6-terra",
      maxTurns: 30,
      timeoutMs: 600_000,
      codex: { binaryPath: "codex", sandbox: "read-only" as const },
    };
    adapter.config.evaluationProviders = { specReview: evaluator };

    await runPreflight(task, adapter, { force: true });

    expect(mockReviewSpecAmbiguity).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        model: "gpt-5.6-terra",
        evaluator,
        projectRoot: adapter.projectRoot,
      }),
    );
  });

  it("contains a spec-review provider failure without claiming a low-risk result", async () => {
    mockReviewSpecAmbiguity.mockRejectedValue(
      new Error("Codex spec review parse_failed: invalid output"),
    );

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.specReview).toBeUndefined();
    expect(result.gate.ready).toBe(true);
    expect(mockGenerateBlueprint).toHaveBeenCalledWith(task, adapter);
  });

  it("skips gate when skipGate option is set", async () => {
    const result: PreflightResult = await runPreflight(task, adapter, {
      skipGate: true,
      force: true,
    });

    expect(mockRunReadinessGate).not.toHaveBeenCalled();
    expect(result.gate.ready).toBe(true);
    expect(result.gate.score).toBe(5);
  });

  it("TASK-1315 (r2b): the PERSISTED gate block carries the mode fingerprint, activeOutcome, and gateSkipped stamps", async () => {
    const fsSync = await import("node:fs");
    const pathMod = await import("node:path");
    const persistedPath = pathMod.join(
      adapter.projectRoot,
      ".quack",
      "prep",
      `${task.id}-preflight.json`,
    );

    // A judgment-opted adapter: the persisted artifact records the mode
    // and the active gate outcome.
    (adapter.config as unknown as Record<string, unknown>).judgment = {
      runner: { provider: "claude-sdk", model: "test-model", maxTurns: 5, timeoutMs: 1_000 },
      stages: { docsReview: { mode: "off" }, readiness: { mode: "shadow" } },
    };
    const result: PreflightResult = await runPreflight(task, adapter, { force: true });
    expect(result.gate.readinessJudgmentMode).toBe("shadow");
    expect(result.gate.activeOutcome).toBe("pass");
    expect(result.gate.gateSkipped).toBeUndefined();

    const persisted = JSON.parse(fsSync.readFileSync(persistedPath, "utf-8")) as PreflightResult;
    expect(persisted.gate.readinessJudgmentMode).toBe("shadow");
    expect(persisted.gate.activeOutcome).toBe("pass");
    expect(persisted.gate.gateSkipped).toBeUndefined();

    // A skipGate run stamps gateSkipped in the persisted artifact so it
    // can never authorize a dispatcher gate skip (r2-F1).
    const skipped: PreflightResult = await runPreflight(task, adapter, {
      skipGate: true,
      force: true,
    });
    expect(skipped.gate.gateSkipped).toBe(true);
    expect(parseFullPreflightResult(skipped)).toEqual(skipped);
    const persistedSkipped = JSON.parse(
      fsSync.readFileSync(persistedPath, "utf-8"),
    ) as PreflightResult;
    expect(persistedSkipped.gate.gateSkipped).toBe(true);
    expect(persistedSkipped.gate.readinessJudgmentMode).toBe("shadow");
  });

  it("caches result and returns cache on second call", async () => {
    const result1: PreflightResult = await runPreflight(task, adapter, { force: true });
    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);

    mockGenerateBlueprint.mockClear();
    mockAssembleContext.mockClear();

    const result2: PreflightResult = await runPreflight(task, adapter);
    expect(mockGenerateBlueprint).not.toHaveBeenCalled();
    expect(result2.taskId).toBe(result1.taskId);
    expect(result2.contentHash).toBe(result1.contentHash);
  });

  it("invalidates cache when task content changes", async () => {
    await runPreflight(task, adapter, { force: true });
    mockGenerateBlueprint.mockClear();

    const modifiedTask = makeTask({
      rawContent: "# TASK-099\n\nModified content for test",
    });

    await runPreflight(modifiedTask, adapter);
    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);
  });

  it("records gate failure when gate rejects", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "rejected",
      reason: "Depth too shallow",
      details: {
        taskType: TaskType.Code,
        threshold: 4.7,
        ready: false,
        overallScore: 2,
        scores: { clarity: 2, scope: 2, testability: 3, conventions: 1 },
        deficiencies: ["Missing implementation detail"],
        enrichmentSuggestions: [],
      },
    });

    const result: PreflightResult = await runPreflight(task, adapter, { force: true });

    expect(result.gate.ready).toBe(false);
    expect(result.gate.score).toBe(2);
    expect(result.blueprint.formattedMarkdown).toContain("Blueprint");
  });

  it("force option bypasses cache", async () => {
    await runPreflight(task, adapter, { force: true });
    mockGenerateBlueprint.mockClear();

    await runPreflight(task, adapter, { force: true });
    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);
  });

  it("only an explicit force bypasses a same-content generation failure after the provider recovers", async () => {
    const failure = blueprintFailure({ source: "claude-sdk", code: "sdk_error", kind: "runtime_unavailable",
      retryable: true, message: "Provider disconnected" });
    mockGenerateBlueprint.mockResolvedValueOnce({ ...mockBlueprint, fileAnalyses: [], generationFailure: failure });
    const failed = await runPreflight(task, adapter, { force: true });
    expect(failed.blueprint.generationFailure).toBeDefined();
    mockGenerateBlueprint.mockClear(); mockRunReadinessGate.mockClear();
    const cached = await runPreflight(task, adapter);
    expect(cached.blueprint.generationFailure).toEqual(failed.blueprint.generationFailure);
    expect(mockGenerateBlueprint).not.toHaveBeenCalled();
    expect(mockRunReadinessGate).not.toHaveBeenCalled();
    const fresh = await runPreflight(task, adapter, { force: true });
    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);
    expect(mockRunReadinessGate).toHaveBeenCalledTimes(1);
    expect(fresh.blueprint.generationFailure).toBeUndefined();
    expect(fresh.contentHash).toBe(failed.contentHash);
  });

  it("emits stage lifecycle events and heartbeats for long-running blueprint work", async () => {
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const reporter = {
      started: jest.fn().mockResolvedValue(undefined),
      heartbeat: jest.fn().mockResolvedValue(undefined),
      completed: jest.fn().mockResolvedValue(undefined),
      failed: jest.fn().mockResolvedValue(undefined),
    };
    mockGenerateBlueprint.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mockBlueprint;
    });

    await runPreflight(task, adapter, {
      force: true,
      events: makeEventWriter(emitted),
      stageReporter: reporter,
      stageHeartbeatIntervalMs: 5,
    });

    const blueprintStages = emitted
      .filter((event) => event.stage.startsWith("stage_"))
      .filter((event) => {
        const payload = event.payload as { stage?: string };
        return payload.stage === "blueprint";
      })
      .map((event) => event.stage);

    expect(blueprintStages).toContain("stage_started");
    expect(blueprintStages).toContain("stage_heartbeat");
    expect(blueprintStages).toContain("stage_completed");
    expect(reporter.started).toHaveBeenCalledWith(
      "blueprint",
      "Generating implementation blueprint.",
    );
    expect(reporter.heartbeat).toHaveBeenCalledWith(
      "blueprint",
      "Generating implementation blueprint.",
    );
    expect(reporter.completed).toHaveBeenCalledWith(
      "blueprint",
      "Generating implementation blueprint.",
    );
    expect(reporter.failed).not.toHaveBeenCalled();
  });

  it("skips auto-decompose when blueprint has no fileAnalyses", async () => {
    // Empty blueprint — decomposer would have nothing concrete to slice along.
    mockGenerateBlueprint.mockResolvedValue({
      taskId: "TASK-099",
      fileAnalyses: [],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: [],
      preconditions: [],
    });

    // Force complexity.recommendDecomposition = true via tight thresholds.
    // The default task has 2 filesToModify and 2 successCriteria, so
    // maxFilesBeforeDecompose=1 makes the task look complex enough to
    // recommend decomposition.
    adapter.config.preflight = {
      autoRun: false,
      complexityThresholds: {
        maxFilesBeforeDecompose: 1,
        maxCriteriaBeforeDecompose: 1,
        maxContextTokensBeforeDecompose: 35_000,
        maxIndependentFeatures: 3,
      },
      autoDecompose: {
        enabled: true,
        maxSubtasks: 5,
        writeSpecs: false,
      },
    };

    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const result = await runPreflight(task, adapter, {
      force: true,
      events: makeEventWriter(emitted),
    });

    // The decomposer must NOT have been invoked.
    expect(mockDecomposeTask).not.toHaveBeenCalled();
    expect(mockWriteSubtaskSpecs).not.toHaveBeenCalled();

    // A skip event must be emitted with the empty-blueprint reason.
    const skipped = emitted.find((e) => e.stage === "preflight_auto_decompose_skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.payload).toMatchObject({
      taskId: "TASK-099",
      reason: "empty_blueprint",
      blueprintFileAnalyses: 0,
    });

    // The "ran decompose" event must NOT have fired.
    const ran = emitted.find((e) => e.stage === "preflight_auto_decompose");
    expect(ran).toBeUndefined();

    // Result has no decomposition.
    expect(result.decomposition).toBeUndefined();
  });

  it("runs auto-decompose when blueprint has fileAnalyses", async () => {
    // Non-empty blueprint — guard should not fire.
    mockGenerateBlueprint.mockResolvedValue(mockBlueprint);
    mockDecomposeTask.mockResolvedValue({
      parentTaskId: "TASK-099",
      subtasks: [
        {
          id: "TASK-099-A",
          title: "Subtask A",
          filesToModify: [{ path: "src/a.ts", action: "Modify", notes: "" }],
          successCriteria: ["criterion 1"],
          dependsOn: [],
          isFinal: true,
        },
      ],
    });
    mockWriteSubtaskSpecs.mockResolvedValue([]);

    adapter.config.preflight = {
      autoRun: false,
      complexityThresholds: {
        maxFilesBeforeDecompose: 1,
        maxCriteriaBeforeDecompose: 1,
        maxContextTokensBeforeDecompose: 35_000,
        maxIndependentFeatures: 3,
      },
      autoDecompose: {
        enabled: true,
        maxSubtasks: 5,
        writeSpecs: false,
      },
    };

    const emitted: Array<{ stage: string; payload: unknown }> = [];
    await runPreflight(task, adapter, {
      force: true,
      events: makeEventWriter(emitted),
    });

    expect(mockDecomposeTask).toHaveBeenCalledTimes(1);
    expect(emitted.find((e) => e.stage === "preflight_auto_decompose")).toBeDefined();
    expect(emitted.find((e) => e.stage === "preflight_auto_decompose_skipped")).toBeUndefined();
  });

  it("emits stage_failed when analysis errors abort preflight", async () => {
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const reporter = {
      started: jest.fn().mockResolvedValue(undefined),
      heartbeat: jest.fn().mockResolvedValue(undefined),
      completed: jest.fn().mockResolvedValue(undefined),
      failed: jest.fn().mockResolvedValue(undefined),
    };
    mockAssembleContext.mockRejectedValueOnce(new Error("analysis exploded"));

    await expect(
      runPreflight(task, adapter, {
        force: true,
        events: makeEventWriter(emitted),
        stageReporter: reporter,
      }),
    ).rejects.toThrow("analysis exploded");

    expect(
      emitted.some((event) => {
        if (event.stage !== "stage_failed") return false;
        const payload = event.payload as { stage?: string; error?: string };
        return payload.stage === "analysis" && payload.error === "analysis exploded";
      }),
    ).toBe(true);
    expect(reporter.failed).toHaveBeenCalledWith(
      "analysis",
      "analysis exploded",
      "Assembling context and complexity estimates.",
    );
  });

  // ─── TASK-1306: structured blueprint persistence ─────────────────

  it("persists the STRUCTURED blueprint on the LLM path (TASK-1306)", async () => {
    const briefBlueprint: Blueprint = {
      ...mockBlueprint,
      briefSchemaVersion: 1,
      generatedAt: "2026-07-15T00:00:00.000Z",
      constraints: ["express 4 only"],
    };
    mockGenerateBlueprint.mockResolvedValue(briefBlueprint);

    const result = await runPreflight(task, adapter, { force: true });
    expect(result.blueprint.structured).toBeDefined();
    expect(result.blueprint.structured!.fileAnalyses).toHaveLength(1);
    expect(result.blueprint.structured!.constraints).toEqual(["express 4 only"]);

    // and it round-trips through the file cache
    const cached = await new PrepCache(tmpDir).readPreflight("TASK-099", result.contentHash);
    expect(cached?.blueprint.structured?.constraints).toEqual(["express 4 only"]);
  });

  it("degrades to the deterministic blueprint when LLM fidelity fails", async () => {
    mockGenerateBlueprint.mockResolvedValue({
      taskId: task.id,
      fileAnalyses: [],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: [],
      preconditions: [],
      fidelity: {
        status: "failed",
        violations: [{ kind: "empty_brief", detail: "No typed directives were produced" }],
        checkedAt: "2026-09-08T00:00:00.000Z",
        scope: "typed-surface+file-existence+mandated-checks",
      },
    });
    const emitted: Array<{ stage: string; payload: unknown }> = [];

    const result = await runPreflight(task, adapter, {
      force: true,
      events: makeEventWriter(emitted),
    });

    expect(result.mode).toBe("deterministic");
    expect(result.degraded?.diagnostics.stderrTail).toContain(
      "Generated blueprint failed deterministic fidelity validation",
    );
    expect(result.blueprint.fileAnalyses).toBe(task.filesToModify.length);
    expect(result.blueprint.structured).toBeUndefined();
    const degradedEvent = emitted.find((event) => event.stage === "preflight_degraded");
    expect(degradedEvent?.payload).toMatchObject({
      taskId: task.id,
      mode: "deterministic",
      reason: "validation_failed", retryable: false,
    });
    expect(result.blueprint.generationFailure?.code).toBe("fidelity_failed");
  });

  it.each(["generated", "legacy"])("preserves a paid %s brief through repeated failures across return, file, SQLite and job serialization", async (provenance) => {
    const generatedAt = "2026-07-15T00:00:00.000Z";
    mockGenerateBlueprint.mockResolvedValue({ ...mockBlueprint, ...(provenance === "generated" ? { generatedAt } : {}) });
    const good = await runPreflight(task, adapter, { force: true });
    const failure = blueprintFailure({ source: "claude-sdk", code: "sdk_error", sdkSubtype: "error_max_turns",
      sdkErrors: ["Maximum turns reached"], kind: "runtime_unavailable", retryable: true, message: "Maximum turns reached" });
    mockGenerateBlueprint.mockResolvedValue({ ...mockBlueprint, fileAnalyses: [], generationFailure: failure });
    mockAssembleContext.mockResolvedValue({ ...mockContext, contextSizeEstimate: { ...mockContextSizeEstimate, total: 1_000_000 } });
    for (let attempt = 0; attempt < 2; attempt++) {
      // Gate evidence stays fresh even while the same-content blueprint is retained.
      adapter.config.gate = { requiredSections: ["filesToModify"] };
      (adapter.config as unknown as Record<string, unknown>).judgment = {
        stages: { readiness: { mode: attempt === 0 ? "shadow" : "enforce" } },
      };
      const emitted: Array<{ stage: string; payload: unknown }> = [];
      const result = await runPreflight(task, adapter, { force: true, events: makeEventWriter(emitted) });
      expect(emitted.find((event) => event.stage === "preflight_complete")?.payload)
        .toMatchObject({ recommendDecomposition: result.complexity.recommendDecomposition });
      expect(result.mode).toBe("deterministic");
      expect(result.degraded?.diagnostics).toMatchObject({ code: "sdk_error", retryable: true });
      expect(result.blueprint.structured).toEqual(good.blueprint.structured);
      expect(result.blueprint.formattedMarkdown).toBe(good.blueprint.formattedMarkdown);
      expect(result.contextEstimate).toEqual(good.contextEstimate);
      expect(result.complexity).toEqual(good.complexity);
      expect(result.schemaPolicyHash).not.toBe(good.schemaPolicyHash);
      expect(result.gate.readinessJudgmentMode).toBe(attempt === 0 ? "shadow" : "enforce");
      expect(result.blueprint.structuredPreserved).toMatchObject({
        preservedFrom: provenance === "generated" ? generatedAt : good.timestamp,
        preservedFromKind: provenance === "generated" ? "generated_at" : "legacy_cache_timestamp",
      });
      const expected: unknown = JSON.parse(JSON.stringify(result));
      expect(await new PrepCache(tmpDir).readPreflight(task.id, result.contentHash)).toEqual(expected);
      expect(JSON.parse(JSON.stringify(parseFullPreflightResult(result)))).toEqual(expected);
      const db = new QuackDB(path.join(tmpDir, ".quack", "quack.db"));
      try {
        expect(JSON.parse(db.getReadinessSnapshot(task.id, result.contentHash)!.preflight_data!)).toEqual(expected);
        expect(JSON.parse(db.getPrep(task.id)!.preflight_data!)).toEqual(expected);
      } finally { db.close(); }
    }
  });

  it.each([true, false])("retains a prior size-omitted paid rendering only with a known positive audit (%s)", async (audited) => {
    mockGenerateBlueprint.mockResolvedValue({ ...mockBlueprint, antiPatterns: ["x".repeat(300_000)],
      generatedAt: "2026-09-01T00:00:00.000Z",
      ...(audited ? { fidelity: { status: "ok" as const, violations: [], checkedAt: "2026-09-01T00:00:00.000Z", scope: "typed-surface+file-existence" as const } } : {}) });
    const good = await runPreflight(task, adapter, { force: true });
    expect(good.blueprint.structured).toBeUndefined();
    mockGenerateBlueprint.mockRejectedValueOnce(new Error("provider disconnected"));
    const result = await runPreflight(task, adapter, { force: true });
    expect(Boolean(result.blueprint.structuredPreserved)).toBe(audited);
    if (audited) {
      expect(result.blueprint.formattedMarkdown).toBe(good.blueprint.formattedMarkdown);
      expect(result.blueprint.fileAnalyses).toBe(good.blueprint.fileAnalyses);
      expect(result.blueprint.generatedAt).toBe(good.blueprint.generatedAt);
      expect(result.blueprint.structuredPreserved?.preservedFrom).toBe(good.blueprint.generatedAt);
      expect(result.contextEstimate).toEqual(good.contextEstimate);
    }
    expect(result.blueprint.structured).toBeUndefined();
    expect(result.mode).toBe("deterministic");
  });

  it("a later successful synthesis replaces retained evidence and clears the failure", async () => {
    await runPreflight(task, adapter, { force: true });
    mockGenerateBlueprint.mockRejectedValueOnce(new Error("provider failed"));
    expect((await runPreflight(task, adapter, { force: true })).blueprint.structuredPreserved).toBeDefined();
    mockFormatBlueprintForPrompt.mockReturnValue("Fresh successful replacement");
    const result = await runPreflight(task, adapter, { force: true });
    expect(result.mode).toBe("full");
    expect(result.degraded).toBeUndefined();
    expect(result.blueprint.generationFailure).toBeUndefined();
    expect(result.blueprint.structuredPreserved).toBeUndefined();
    expect(result.blueprint.formattedMarkdown).toBe("Fresh successful replacement");
    expect((await new PrepCache(tmpDir).readPreflight(task.id))?.blueprint).toEqual(result.blueprint);
  });

  it("gate fallback events keep their actual kind and do not invent blueprint-provider failures", async () => {
    mockRunReadinessGate.mockRejectedValueOnce(new QuackRuntimeError("bad gate payload", {
      kind: "validation_failed", stage: "preflight.gate", retryable: false,
    }));
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const result = await runPreflight(task, adapter, { force: true, events: makeEventWriter(emitted) });
    expect(result.degraded?.diagnostics.kind).toBe("validation_failed");
    expect(emitted.find((event) => event.stage === "preflight_degraded")?.payload)
      .toMatchObject({ reason: "validation_failed", retryable: false });
    expect(result.blueprint.generationFailure).toBeUndefined();
    expect(mockGenerateBlueprint).not.toHaveBeenCalled();
  });

  it.each(["changed", "absent"])("does not retain a previous brief for %s content evidence", async (prior) => {
    if (prior === "changed") await runPreflight(task, adapter, { force: true });
    task.rawContent += "\nNew task requirements";
    mockGenerateBlueprint.mockRejectedValue(new Error("provider crashed"));
    const result = await runPreflight(task, adapter, { force: true });
    expect(result.blueprint.structured).toBeUndefined();
    expect(result.blueprint.structuredPreserved).toBeUndefined();
    expect(result.blueprint.generationFailure).toMatchObject({ code: "exception", kind: "internal_error", retryable: false });
  });

  it("preserves paid content when a huge failed synthesis loses its structured rendering", async () => {
    const good = await runPreflight(task, adapter, { force: true });
    mockGenerateBlueprint.mockResolvedValue({ ...mockBlueprint, antiPatterns: ["x".repeat(300_000)],
      fidelity: { status: "failed", violations: [{ kind: "missing_file", detail: "Missing source" }],
        checkedAt: new Date().toISOString(), scope: "typed-surface+file-existence" } });
    const result = await runPreflight(task, adapter, { force: true });
    expect(result.blueprint.structured).toEqual(good.blueprint.structured);
    expect(result.blueprint.generationFailure).toMatchObject({ code: "fidelity_failed", kind: "validation_failed", retryable: false });
    expect(result.degraded?.reason).toContain("Missing source");
  });

  it("leaves structured ABSENT on the deterministic path (honesty over stubs)", async () => {
    const result = await runPreflight(task, adapter, {
      force: true,
      mode: "deterministic",
    });
    expect(result.mode).toBe("deterministic");
    expect(result.blueprint.structured).toBeUndefined();
    expect(result.blueprint.generationFailure).toBeUndefined();
  });

  it("omits structured past the 256KB guard with an event note, storing the rest", async () => {
    const huge: Blueprint = {
      ...mockBlueprint,
      antiPatterns: [
        ...mockBlueprint.antiPatterns,
        "x".repeat(300_000), // pathological — over the 256KB serialized guard
      ],
    };
    mockGenerateBlueprint.mockResolvedValue(huge);

    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const result = await runPreflight(task, adapter, {
      force: true,
      events: makeEventWriter(emitted),
    });

    expect(result.blueprint.structured).toBeUndefined();
    expect(result.blueprint.formattedMarkdown.length).toBeGreaterThan(0);
    const note = emitted.find((e) => e.stage === "blueprint_structured_omitted");
    expect(note).toBeDefined();
    expect((note!.payload as { bytes: number }).bytes).toBeGreaterThan(256_000);
  });
});
