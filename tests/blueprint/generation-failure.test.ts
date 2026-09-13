import {
  generateBlueprint,
  _setQueryFn,
  stampBriefProvenance,
} from "../../src/blueprint/blueprint-agent";
import {
  blueprintFailure,
  blueprintFailureFromError,
} from "../../src/blueprint/generation-failure";
import {
  runCodexStructuredEvaluation,
  type CodexStructuredErrorKind,
} from "../../src/llm/codex-structured-evaluator";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { parseTaskFile } from "../../src/core/task-parser";
import { QuackRuntimeError } from "../../src/core/runtime-errors";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import { taskSpec } from "../helpers/divergent-task-fixture";

jest.mock("../../src/llm/codex-structured-evaluator", () => ({
  runCodexStructuredEvaluation: jest.fn(),
}));
const evaluate = jest.mocked(runCodexStructuredEvaluation);
const task = parseTaskFile(taskSpec("TASK-1356"));
const config = AdapterConfigSchema.parse({
  version: "1.0.0",
  project: { name: "failure-fixture", root: ".", taskDir: "docs/tasks", conventionsDir: ".quack" },
  verification: {
    commands: [{ name: "noop", command: "echo ok", required: false, timeout: 1000 }],
  },
  git: { commitFormat: "[{taskId}] {message}", commitTrailer: "" },
  logging: { dir: ".quack/logs" },
});
const adapter: ProjectAdapter = {
  projectRoot: "/nonexistent/quack-blueprint-fixture",
  config,
  conventionsDoc: "",
  judgeCriteria: "",
  conventionCheckScripts: [],
  adrDocs: {},
  adapterBundle: {
    authority: "local",
    sharedHash: "fixture",
    normalizedConfig: config,
    machineLocalFields: [],
  },
};
const good: Blueprint = {
  taskId: task.id,
  fileAnalyses: [
    {
      filePath: "new.ts",
      action: "Create",
      currentStructure: "new",
      integrationPoints: "new",
      patternToFollow: "new",
    },
  ],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
  preconditions: [],
};

afterEach(() => {
  _setQueryFn(undefined);
  jest.useRealTimers();
  jest.clearAllMocks();
});

it.each([
  ["spawn_failed", "runtime_unavailable", true],
  ["unavailable", "runtime_unavailable", true],
  ["timeout", "runtime_unavailable", true],
  ["session_error", "runtime_unavailable", true],
  ["protocol_error", "validation_failed", true],
  ["parse_failed", "validation_failed", true],
  ["invalid_config", "internal_error", false],
  ["tree_mutated", "internal_error", false],
] as const)(
  "preserves Codex %s classification independently of misleading error text",
  async (code, kind, retryable) => {
    const codexAdapter = {
      ...adapter,
      config: {
        ...config,
        evaluationProviders: {
          blueprint: {
            runner: "codex-cli" as const,
            model: "fixture-model",
            maxTurns: 5,
            timeoutMs: 1000,
            codex: { binaryPath: "unused", sandbox: "read-only" as const },
          },
        },
      },
    } as ProjectAdapter;
    evaluate.mockResolvedValue({
      status: "runner_error",
      errorKind: code as CodexStructuredErrorKind,
      message: "schema validation failed: credit timeout spawn",
      exitCode: 7,
      durationMs: 1,
    });
    const result = await generateBlueprint(task, codexAdapter);
    expect(result.generationFailure).toMatchObject({
      source: "codex-cli",
      code,
      kind,
      retryable,
      exitCode: 7,
    });
    expect(result.fidelity?.status).toBe("failed");
  },
);

it("retains bounded SDK subtype/errors without persisting model output", async () => {
  _setQueryFn(async function* () {
    await Promise.resolve();
    yield {
      type: "result",
      subtype: "error_max_turns",
      errors: ["Need more turns", "x".repeat(5000)],
    };
  });
  const result = await generateBlueprint(task, adapter);
  expect(result.generationFailure).toMatchObject({
    source: "claude-sdk",
    code: "sdk_error",
    sdkSubtype: "error_max_turns",
    kind: "runtime_unavailable",
    retryable: true,
  });
  expect(result.generationFailure?.sdkErrors?.[0]).toBe("Need more turns");
  expect(result.generationFailure?.sdkErrors?.[1]).toHaveLength(300);
  expect(result.generationFailure!.message.length).toBeLessThanOrEqual(2000);
});

it("distinguishes extraction failure from no final result", async () => {
  _setQueryFn(async function* () {
    await Promise.resolve();
    yield { type: "result", subtype: "success", result: "PRIVATE MODEL OUTPUT" };
  });
  const extraction = await generateBlueprint(task, adapter);
  expect(extraction.generationFailure).toMatchObject({
    code: "parse_failed",
    kind: "validation_failed",
    retryable: true,
  });
  expect(JSON.stringify(extraction)).not.toContain("PRIVATE MODEL OUTPUT");
  _setQueryFn(async function* () {
    await Promise.resolve();
    yield { type: "system" };
  });
  expect((await generateBlueprint(task, adapter)).generationFailure).toMatchObject({
    code: "no_final_result",
    kind: "runtime_unavailable",
    retryable: true,
  });
});

it.each(["setup", "iteration"])(
  "captures typed %s failures that formerly escaped or lost classification",
  async (stage) => {
    const error = new QuackRuntimeError("opaque provider message", {
      kind: "validation_failed",
      stage: "fixture",
      retryable: true,
      exitCode: 8,
    });
    _setQueryFn(
      stage === "setup"
        ? () => {
            throw error;
          }
        : async function* () {
    await Promise.resolve();
            yield { type: "system" };
            throw error;
          },
    );
    expect((await generateBlueprint(task, adapter)).generationFailure).toMatchObject({
      kind: "validation_failed",
      retryable: true,
      exitCode: 8,
      message: error.message,
    });
  },
);

it("maps known unavailable setup, unexpected exceptions and actual timeout separately", async () => {
  _setQueryFn(() => {
    throw Object.assign(new Error("missing binary"), { code: "ENOENT" });
  });
  expect((await generateBlueprint(task, adapter)).generationFailure).toMatchObject({
    kind: "runtime_unavailable",
    retryable: true,
    code: "ENOENT",
  });
  expect(blueprintFailureFromError(new Error("credit timeout spawn"), "pipeline")).toMatchObject({
    kind: "internal_error",
    retryable: false,
  });
  jest.useFakeTimers();
  _setQueryFn(async function* () {
    await Promise.resolve();
    yield { type: "system" };
    await new Promise<void>(() => undefined);
  });
  const pending = generateBlueprint(task, adapter);
  await jest.advanceTimersByTimeAsync(600_000);
  expect((await pending).generationFailure).toMatchObject({
    code: "timeout",
    kind: "runtime_unavailable",
    retryable: true,
  });
  expect(jest.getTimerCount()).toBe(0);
});

it("does not accept a model-authored failure stamp on successful generation", async () => {
  const spoof = {
    ...good,
    generationFailure: blueprintFailure({
      source: "pipeline",
      code: "forged",
      message: "forged",
      kind: "internal_error",
      retryable: false,
    }),
  };
  _setQueryFn(async function* () {
    await Promise.resolve();
    yield { type: "result", subtype: "success", result: JSON.stringify(spoof) };
  });
  const result = await generateBlueprint(task, adapter);
  expect(result.generationFailure).toBeUndefined();
  expect(result.fidelity?.status).toBe("ok");
  expect(stampBriefProvenance(spoof, adapter.projectRoot).generationFailure).toBeUndefined();
});
