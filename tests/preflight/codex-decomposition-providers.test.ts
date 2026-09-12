import { computeAdapterBundleMetadata, type ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, ParsedTask } from "../../src/core/types";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { DecompositionTopology, SubtaskDefinition } from "../../src/preflight/decompose-types";

const mockStructuredEvaluation = jest.fn();
jest.mock("../../src/llm/codex-structured-evaluator", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  runCodexStructuredEvaluation: (...args: unknown[]) => mockStructuredEvaluation(...args),
}));

import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import {
  decomposeTask,
  _setQueryFn as setDecomposeQueryFn,
} from "../../src/preflight/task-decomposer";
import {
  materializeChildDrafts,
  _setQueryFn as setMaterializeQueryFn,
} from "../../src/preflight/subtask-materializer";

const evaluator = {
  runner: "codex-cli" as const,
  model: "gpt-5.6-terra",
  maxTurns: 30,
  timeoutMs: 600_000,
  codex: {
    binaryPath: "codex",
    sandbox: "read-only" as const,
  },
};

const task: ParsedTask = {
  id: "TASK-018",
  title: "Split the demo feature",
  priority: "P1-HIGH",
  effort: "6 hours",
  status: "READY",
  supersededBy: [],
  supersedes: [],
  relevanceReview: "",
  blockedBy: [],
  blocks: [],
  conventions: [],
  tags: ["demo"],
  problemStatement:
    "The feature spans independent runtime and test files that need explicit ownership.",
  currentState: "The implementation is still grouped in one parent task.",
  recommendedApproach: "Separate runtime ownership from integration verification.",
  filesToModify: [
    { path: "src/a.ts", action: "Create", notes: "Runtime A" },
    { path: "src/b.ts", action: "Create", notes: "Runtime B" },
    { path: "tests/a.test.ts", action: "Create", notes: "Tests A" },
  ],
  successCriteria: ["Runtime A works", "Runtime B works", "Integration tests pass"],
  testingRequirements: ["Exercise each runtime path"],
  contextReferences: ["docs/ARCHITECTURE.md"],
  rawContent: "# TASK-018: Split the demo feature",
};

const blueprint: Blueprint = {
  taskId: task.id,
  fileAnalyses: task.filesToModify.map((file) => ({
    filePath: file.path,
    action: file.action,
    currentStructure: "New file",
    integrationPoints: "None",
    patternToFollow: "Existing modules",
  })),
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
  preconditions: [],
};

function makeAdapter(
  evaluationProviders?: AdapterConfig["evaluationProviders"],
  configuredMaxSubtasks?: number,
): ProjectAdapter {
  return {
    projectRoot: "C:/demo/project",
    config: {
      version: "1.0",
      project: {
        name: "demo",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: ".quack",
      },
      modelRouting: {
        gateModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        plannerModel: "claude-sonnet-4-6",
        workerModel: "claude-sonnet-4-6",
        workerComplexModel: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        retryEscalation: false,
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
        commands: [{ name: "tests", command: "npm test", required: true, timeout: 300_000 }],
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: ["src/**", "tests/**"],
        deniedPaths: [],
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
      ...(configuredMaxSubtasks === undefined
        ? {}
        : {
            preflight: {
              autoDecompose: {
                enabled: true,
                maxSubtasks: configuredMaxSubtasks,
                writeSpecs: true,
              },
            },
          }),
    },
    conventionsDoc: "Keep child scopes isolated.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    claudeMd: "",
  } as unknown as ProjectAdapter;
}

function validSubtasks(): SubtaskDefinition[] {
  return [
    {
      id: "TASK-018-A",
      title: "Build runtimes",
      filesToModify: [
        { path: "src/a.ts", action: "Create", notes: "Runtime A" },
        { path: "src/b.ts", action: "Create", notes: "Runtime B" },
      ],
      successCriteria: ["Runtime A works", "Runtime B works"],
      dependsOn: [],
      isFinal: false,
    },
    {
      id: "TASK-018-B",
      title: "Verify integration",
      filesToModify: [{ path: "tests/a.test.ts", action: "Create", notes: "Tests A" }],
      successCriteria: ["Integration tests pass"],
      dependsOn: ["TASK-018-A"],
      isFinal: true,
    },
  ];
}

function topology(subtasks = validSubtasks()): DecompositionTopology {
  return {
    parentTaskId: task.id,
    subtasks,
    coverageReport: {
      fileOwnership: [],
      criterionOwnership: [],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      hasCoverageGap: false,
    },
  };
}

function richMarkdown(subtaskId: string, title: string): string {
  const isRuntimeChild = subtaskId.endsWith("-A");
  const blockedBy = isRuntimeChild ? "" : "TASK-018-A";
  const fileRows = isRuntimeChild
    ? "| `src/a.ts` | Create | Runtime A |\n| `src/b.ts` | Create | Runtime B |"
    : "| `tests/a.test.ts` | Create | Integration tests |";
  const criteria = isRuntimeChild
    ? "- [ ] Runtime A works\n- [ ] Runtime B works"
    : "- [ ] Integration tests pass";
  return `# ${subtaskId}: ${title}

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** [${blockedBy}]
- **Blocks:** []
- **Tags:** demo, subtask

## Problem Statement
This child owns a focused portion of the demo architecture and must provide a concrete contract for its downstream integration consumer.

## Current State
The owned source file is absent and no sibling currently provides the required runtime behavior.

## Recommended Approach
Implement the owned module with explicit inputs, deterministic outputs, and a narrow exported interface consumed by the integration child.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
${fileRows}

## Success Criteria
${criteria}

## Testing Requirements
- [ ] Unit test validates the successful runtime path
- [ ] Unit test validates invalid input behavior
- [ ] Integration test validates the sibling contract

## Anti-Patterns
- Do NOT expose mutable internal state
- Do NOT hide invalid input failures
- Do NOT widen the owned file scope

## Context References
- Parent task: TASK-018
`;
}

type StructuredRequest = {
  outputSchema: Record<string, unknown>;
  parse: (rawText: string) => unknown;
  prompt: string;
};

function mockStructuredRaw(rawForRequest: (request: StructuredRequest) => string): void {
  mockStructuredEvaluation.mockImplementation((rawRequest: unknown) => {
    const request = rawRequest as StructuredRequest;
    const raw = rawForRequest(request);
    const value = request.parse(raw);
    if (value === null) {
      return Promise.resolve({
        status: "runner_error",
        errorKind: "parse_failed",
        message: "stage schema rejected output",
        durationMs: 1,
      });
    }
    return Promise.resolve({
      status: "completed",
      value,
      rawText: raw,
      sessionId: "codex-decompose",
      turnsUsed: 1,
      durationMs: 1,
    });
  });
}

function firstStructuredRequest(): StructuredRequest {
  const calls = mockStructuredEvaluation.mock.calls as unknown[][];
  return calls[0][0] as StructuredRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  setDecomposeQueryFn(undefined);
  setMaterializeQueryFn(undefined);
});

describe("Codex decomposition providers", () => {
  test("adapter schema keeps Claude defaults and accepts both explicit providers", () => {
    const base = makeAdapter().config;
    expect(AdapterConfigSchema.parse(base).evaluationProviders).toBeUndefined();

    const configured = AdapterConfigSchema.parse({
      ...base,
      evaluationProviders: {
        taskDecomposition: evaluator,
        childSpecMaterialization: evaluator,
      },
    });

    expect(configured.evaluationProviders?.taskDecomposition?.runner).toBe("codex-cli");
    expect(configured.evaluationProviders?.childSpecMaterialization?.runner).toBe("codex-cli");
  });

  test("excludes both provider Codex homes from the shared adapter identity", () => {
    const providerAt = (codexHome: string) => ({
      ...evaluator,
      codex: { ...evaluator.codex, codexHome },
    });
    const hostA = computeAdapterBundleMetadata(
      makeAdapter({
        taskDecomposition: providerAt("C:/Users/host-a/.codex"),
        childSpecMaterialization: providerAt("C:/Users/host-a/.codex"),
      }).config,
    );
    const hostB = computeAdapterBundleMetadata(
      makeAdapter({
        taskDecomposition: providerAt("/home/host-b/.codex"),
        childSpecMaterialization: providerAt("/home/host-b/.codex"),
      }).config,
    );

    expect(hostA.sharedHash).toBe(hostB.sharedHash);
    expect(
      hostA.normalizedConfig.evaluationProviders?.taskDecomposition?.codex.codexHome,
    ).toBeUndefined();
    expect(
      hostA.normalizedConfig.evaluationProviders?.childSpecMaterialization?.codex.codexHome,
    ).toBeUndefined();
  });

  test("routes an LLM topology fallback through a strict Codex stage schema", async () => {
    mockStructuredRaw(() => JSON.stringify({ subtasks: validSubtasks() }));

    const result = await decomposeTask(
      task,
      makeAdapter({ taskDecomposition: evaluator }),
      blueprint,
      { maxSubtasks: 2 },
    );

    expect(result.subtasks.map((child) => child.id)).toEqual(["TASK-018-A", "TASK-018-B"]);
    expect(result.maxSubtasks).toBe(2);
    const request = firstStructuredRequest();
    expect(request.outputSchema).toMatchObject({
      type: "object",
      required: ["subtasks"],
      additionalProperties: false,
      properties: { subtasks: { minItems: 2, maxItems: 2 } },
    });
    expect(request.prompt).toContain("Task Topology Planning Request");
  });

  test("caps a requested maximum at the adapter maximum and carries it to later stages", async () => {
    mockStructuredRaw(() => JSON.stringify({ subtasks: validSubtasks() }));

    const result = await decomposeTask(
      task,
      makeAdapter({ taskDecomposition: evaluator }, 2),
      blueprint,
      { maxSubtasks: 6, preferConfiguredProvider: true },
    );

    expect(result.maxSubtasks).toBe(2);
    expect(firstStructuredRequest().outputSchema).toMatchObject({
      properties: { subtasks: { minItems: 2, maxItems: 2 } },
    });
  });

  test("uses a lower adapter maximum when the request relies on its default", async () => {
    mockStructuredRaw(() => JSON.stringify({ subtasks: validSubtasks() }));

    const result = await decomposeTask(
      task,
      makeAdapter({ taskDecomposition: evaluator }, 2),
      blueprint,
      { preferConfiguredProvider: true },
    );

    expect(result.maxSubtasks).toBe(2);
    expect(firstStructuredRequest().outputSchema).toMatchObject({
      properties: { subtasks: { minItems: 2, maxItems: 2 } },
    });
  });

  test("allows the global upper bound when the adapter explicitly permits it", async () => {
    mockStructuredRaw(() => JSON.stringify({ subtasks: validSubtasks() }));

    const result = await decomposeTask(
      task,
      makeAdapter({ taskDecomposition: evaluator }, 6),
      blueprint,
      { maxSubtasks: 6, preferConfiguredProvider: true },
    );

    expect(result.maxSubtasks).toBe(6);
    expect(firstStructuredRequest().outputSchema).toMatchObject({
      properties: { subtasks: { minItems: 2, maxItems: 6 } },
    });
  });

  test.each([1, 7])("rejects requested maximum %s outside the global bounds", async (maximum) => {
    await expect(
      decomposeTask(task, makeAdapter({ taskDecomposition: evaluator }, 6), blueprint, {
        maxSubtasks: maximum,
        preferConfiguredProvider: true,
      }),
    ).rejects.toThrow("integer from 2 to 6");
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });

  test.each([
    ["single-child pseudo-decomposition", { subtasks: [{ ...validSubtasks()[0], isFinal: true }] }],
    ["malformed child shape", { subtasks: [{ id: "TASK-018-A", unexpected: true }] }],
    [
      "duplicate child identities",
      { subtasks: [validSubtasks()[0], { ...validSubtasks()[1], id: "TASK-018-A" }] },
    ],
    [
      "parent identity collision",
      { subtasks: [{ ...validSubtasks()[0], id: "TASK-018" }, validSubtasks()[1]] },
    ],
  ])("fails closed on %s", async (_label, response) => {
    mockStructuredRaw(() => JSON.stringify(response));

    await expect(
      decomposeTask(task, makeAdapter({ taskDecomposition: evaluator }), blueprint, {
        maxSubtasks: 2,
      }),
    ).rejects.toThrow(/Codex task decomposition parse_failed/);
  });

  test("keeps deterministic file clustering ahead of the configured provider", async () => {
    const compactTask = {
      ...task,
      filesToModify: task.filesToModify.slice(0, 2),
      successCriteria: task.successCriteria.slice(0, 2),
    };
    const compactBlueprint = {
      ...blueprint,
      fileAnalyses: blueprint.fileAnalyses.slice(0, 2),
    };

    const result = await decomposeTask(
      compactTask,
      makeAdapter({ taskDecomposition: evaluator }),
      compactBlueprint,
      { maxSubtasks: 2 },
    );

    expect(result.subtasks).toHaveLength(2);
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });

  test("prefers the configured provider for auto-write plans with grouped and annotated file rows", async () => {
    const groupedTask: ParsedTask = {
      ...task,
      filesToModify: [
        {
          path: "package.json, package-lock.json",
          action: "Modify",
          notes: "Add the smoke-test runtime",
        },
        {
          path: "tests/smoke/fixtures/* (if used)",
          action: "Create",
          notes: "Browser import fixture",
        },
      ],
      successCriteria: [
        "The smoke command installs reproducibly",
        "The browser fixture resolves from an HTTP base URL",
      ],
    };
    const groupedSubtasks = [
      {
        id: "TASK-018-A",
        title: "Configure smoke runtime",
        filesToModify: [groupedTask.filesToModify[0]],
        successCriteria: [groupedTask.successCriteria[0]],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-018-B",
        title: "Verify browser fixture",
        filesToModify: [groupedTask.filesToModify[1]],
        successCriteria: [groupedTask.successCriteria[1]],
        dependsOn: ["TASK-018-A"],
        isFinal: true,
      },
    ];
    mockStructuredRaw(() => JSON.stringify({ subtasks: groupedSubtasks }));

    const result = await decomposeTask(
      groupedTask,
      makeAdapter({ taskDecomposition: evaluator }),
      blueprint,
      { maxSubtasks: 2, preferConfiguredProvider: true },
    );

    expect(mockStructuredEvaluation).toHaveBeenCalledTimes(1);
    expect(result.subtasks).toEqual(groupedSubtasks);
    expect(result.coverageReport.hasCoverageGap).toBe(false);
  });

  test("keeps the Claude SDK topology path when no provider is configured", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const queryFn = async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify({ subtasks: validSubtasks() }),
      };
    };
    setDecomposeQueryFn(queryFn as unknown as Parameters<typeof setDecomposeQueryFn>[0]);

    const result = await decomposeTask(task, makeAdapter(), blueprint, {
      maxSubtasks: 2,
    });

    expect(result.subtasks).toHaveLength(2);
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });

  test("materialization enforces the adapter-capped maximum carried by the plan", async () => {
    const subtasks: SubtaskDefinition[] = [
      {
        ...validSubtasks()[0],
        filesToModify: [task.filesToModify[0]],
        successCriteria: [task.successCriteria[0]],
      },
      {
        ...validSubtasks()[1],
        id: "TASK-018-B",
        filesToModify: [task.filesToModify[1]],
        successCriteria: [task.successCriteria[1]],
        dependsOn: ["TASK-018-A"],
        isFinal: false,
      },
      {
        ...validSubtasks()[1],
        id: "TASK-018-C",
        filesToModify: [task.filesToModify[2]],
        successCriteria: [task.successCriteria[2]],
        dependsOn: ["TASK-018-B"],
        isFinal: true,
      },
    ];

    await expect(
      materializeChildDrafts(
        { ...topology(subtasks), maxSubtasks: 2 },
        task,
        makeAdapter(undefined, 6),
        blueprint,
      ),
    ).rejects.toThrow(/must contain 2\.\.configuredMax/i);
  });

  test("makes the Claude prompt and parser enforce the configured maximum without slicing", async () => {
    const oversized = [
      {
        id: "TASK-018-A",
        title: "Build runtime A",
        filesToModify: [task.filesToModify[0]],
        successCriteria: [task.successCriteria[0]],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-018-B",
        title: "Build runtime B",
        filesToModify: [task.filesToModify[1]],
        successCriteria: [task.successCriteria[1]],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-018-C",
        title: "Verify integration",
        filesToModify: [task.filesToModify[2]],
        successCriteria: [task.successCriteria[2]],
        dependsOn: ["TASK-018-A", "TASK-018-B"],
        isFinal: true,
      },
    ];
    let submittedPrompt = "";
    // eslint-disable-next-line @typescript-eslint/require-await
    const queryFn = async function* (request: { prompt: string }) {
      submittedPrompt = request.prompt;
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify({ subtasks: oversized }),
      };
    };
    setDecomposeQueryFn(queryFn as unknown as Parameters<typeof setDecomposeQueryFn>[0]);

    await expect(decomposeTask(task, makeAdapter(), blueprint, { maxSubtasks: 2 })).rejects.toThrow(
      "Response JSON failed the task decomposition contract",
    );
    expect(submittedPrompt).toContain("Create between 2 and 2 subtasks");
  });

  test("materializes valid child specs through the explicit Codex provider", async () => {
    mockStructuredRaw((request) => {
      const id = request.prompt.includes("**ID:** TASK-018-A\n") ? "TASK-018-A" : "TASK-018-B";
      const title = id.endsWith("A") ? "Build runtimes" : "Verify integration";
      return JSON.stringify({ subtaskId: id, markdown: richMarkdown(id, title) });
    });

    const drafts = await materializeChildDrafts(
      topology(),
      task,
      makeAdapter({ childSpecMaterialization: evaluator }),
      blueprint,
    );

    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.prepReady)).toBe(true);
    expect(mockStructuredEvaluation).toHaveBeenCalledTimes(2);
    const request = firstStructuredRequest();
    expect(request.outputSchema).toMatchObject({
      type: "object",
      required: ["subtaskId", "markdown"],
      additionalProperties: false,
    });
  });

  test("keeps the Claude SDK materialization path when no provider is configured", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const queryFn = async function* (request: { prompt: string }) {
      const id = request.prompt.includes("**ID:** TASK-018-A\n") ? "TASK-018-A" : "TASK-018-B";
      const title = id.endsWith("A") ? "Build runtimes" : "Verify integration";
      yield {
        type: "result",
        subtype: "success",
        result: richMarkdown(id, title),
      };
    };
    setMaterializeQueryFn(queryFn as unknown as Parameters<typeof setMaterializeQueryFn>[0]);

    const drafts = await materializeChildDrafts(topology(), task, makeAdapter(), blueprint);

    expect(drafts).toHaveLength(2);
    expect(drafts.every((draft) => draft.prepReady)).toBe(true);
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });

  test.each([
    ["missing markdown", { subtaskId: "TASK-018-A" }],
    [
      "conflicting wrapper identity",
      { subtaskId: "TASK-018-B", markdown: richMarkdown("TASK-018-A", "Build runtimes") },
    ],
    [
      "conflicting markdown identity",
      { subtaskId: "TASK-018-A", markdown: richMarkdown("TASK-999-A", "Build runtimes") },
    ],
  ])("returns a blocked draft for %s", async (_label, response) => {
    mockStructuredRaw((request) =>
      JSON.stringify(
        request.prompt.includes("**ID:** TASK-018-A\n")
          ? response
          : {
              subtaskId: "TASK-018-B",
              markdown: richMarkdown("TASK-018-B", "Verify integration"),
            },
      ),
    );

    const drafts = await materializeChildDrafts(
      topology(),
      task,
      makeAdapter({ childSpecMaterialization: evaluator }),
      blueprint,
    );

    expect(drafts[0]).toMatchObject({
      subtaskId: "TASK-018-A",
      prepReady: false,
      prepScore: 0,
    });
    expect(drafts[0].parseError).toMatch(/Codex child spec materialization parse_failed/);
  });

  test("rejects a single-child topology before materialization", async () => {
    await expect(
      materializeChildDrafts(
        topology([{ ...validSubtasks()[0], isFinal: true }]),
        task,
        makeAdapter({ childSpecMaterialization: evaluator }),
        blueprint,
      ),
    ).rejects.toThrow(/must contain 2\.\.configuredMax/i);
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });

  test("rejects duplicate topology identities before materialization", async () => {
    const duplicate = { ...validSubtasks()[1], id: "TASK-018-A" };

    await expect(
      materializeChildDrafts(
        topology([validSubtasks()[0], duplicate]),
        task,
        makeAdapter({ childSpecMaterialization: evaluator }),
        blueprint,
      ),
    ).rejects.toThrow(/sequential children|identity/i);
    expect(mockStructuredEvaluation).not.toHaveBeenCalled();
  });
});
