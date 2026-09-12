import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import {
  _setCodexStructuredSpawnFn,
  _setCodexStructuredWorkspaceProbeFn,
  buildCodexStructuredArgs,
  prepareCodexOutputSchema,
  runCodexStructuredEvaluation,
  type StructuredEvaluatorSpawnFn,
} from "../../src/llm/codex-structured-evaluator";
import { ReviewerRunnerConfigSchema } from "../../src/review/reviewer-config";
import type { WorkspaceSnapshot } from "../../src/worker/codex-agent-worker";
import { codexShellEnvironmentPolicyArgs } from "../../src/llm/codex-process-security";

const ORIGINAL_QUACK_SENTINEL = process.env.QUACK_SENTINEL_SECRET;
const ORIGINAL_AZURE_CREDENTIAL = process.env.AZURE_OPENAI_API_KEY;

class FakeStdin extends EventEmitter {
  written = "";
  end(value?: string): void {
    this.written += value ?? "";
  }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  pid = 7331;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Parameters<StructuredEvaluatorSpawnFn>[2];
  child: FakeChild;
}

const cleanSnapshot: WorkspaceSnapshot = {
  head: "abc123",
  branch: "quack/TASK-008",
  entries: {},
};

const config = ReviewerRunnerConfigSchema.parse({
  runner: "codex-cli",
  model: "gpt-5.6-terra",
  timeoutMs: 1_000,
  codex: {
    binaryPath: "codex",
    sandbox: "read-only",
    codexHome: "C:/Users/demo/.codex-headless",
    profile: "headless",
    provider: "azure",
  },
});

function installSpawn(script: (child: FakeChild, call: SpawnCall) => void): SpawnCall[] {
  const calls: SpawnCall[] = [];
  _setCodexStructuredSpawnFn(((command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    if (command !== "taskkill") setImmediate(() => script(child, call));
    return child as unknown as ChildProcess;
  }) as StructuredEvaluatorSpawnFn);
  return calls;
}

function emitSuccess(child: FakeChild, call: SpawnCall, output: string): void {
  const outputPath = call.args[call.args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(outputPath, output, "utf8");
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "thread.started", thread_id: "eval-session-1" })}\n`,
  );
  child.stdout.emit("data", `${JSON.stringify({ type: "turn.completed" })}\n`);
  child.emit("close", 0, null);
}

function request() {
  return {
    projectRoot: "C:/demo/worktree",
    prompt: "Evaluate this artifact.",
    systemPrompt: "Return only JSON.",
    model: "gpt-5.6-terra",
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    parse: (rawText: string): { ok: boolean } | null => {
      try {
        const parsed = JSON.parse(rawText) as { ok?: unknown };
        return typeof parsed.ok === "boolean" ? { ok: parsed.ok } : null;
      } catch {
        return null;
      }
    },
  };
}

beforeEach(() => {
  _setCodexStructuredWorkspaceProbeFn(() => Promise.resolve(cleanSnapshot));
});

afterEach(() => {
  _setCodexStructuredSpawnFn(undefined);
  _setCodexStructuredWorkspaceProbeFn(undefined);
  if (ORIGINAL_QUACK_SENTINEL === undefined) {
    delete process.env.QUACK_SENTINEL_SECRET;
  } else {
    process.env.QUACK_SENTINEL_SECRET = ORIGINAL_QUACK_SENTINEL;
  }
  if (ORIGINAL_AZURE_CREDENTIAL === undefined) {
    delete process.env.AZURE_OPENAI_API_KEY;
  } else {
    process.env.AZURE_OPENAI_API_KEY = ORIGINAL_AZURE_CREDENTIAL;
  }
});

describe("buildCodexStructuredArgs", () => {
  test("pins a read-only schema-constrained invocation with no escalation surface", () => {
    const args = buildCodexStructuredArgs({
      config,
      request: request(),
      schemaFile: "C:/temp/schema.json",
      outputFile: "C:/temp/result.json",
    });
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "-p",
      "headless",
      "-c",
      'model_provider="azure"',
      ...codexShellEnvironmentPolicyArgs(),
      "-m",
      "gpt-5.6-terra",
      "--cd",
      "C:/demo/worktree",
      "--json",
      "--output-schema",
      "C:/temp/schema.json",
      "--output-last-message",
      "C:/temp/result.json",
      "-",
    ]);
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("prepareCodexOutputSchema", () => {
  test("recursively requires every object property and preserves optionality with null", () => {
    const source = {
      type: "object",
      properties: {
        id: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              requiredValue: { type: "string" },
              optionalCount: { type: "number" },
            },
            required: ["requiredValue"],
          },
        },
        optionalNote: { type: "string" },
      },
      required: ["id", "items"],
    };

    const prepared = prepareCodexOutputSchema(source);
    expect(prepared.required).toEqual(["id", "items", "optionalNote"]);
    expect(prepared.additionalProperties).toBe(false);
    const properties = prepared.properties as Record<string, unknown>;
    expect(properties.optionalNote).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    const items = properties.items as Record<string, unknown>;
    const nested = items.items as Record<string, unknown>;
    expect(nested.required).toEqual(["requiredValue", "optionalCount"]);
    expect(nested.additionalProperties).toBe(false);
    expect((nested.properties as Record<string, unknown>).optionalCount).toEqual({
      anyOf: [{ type: "number" }, { type: "null" }],
    });
    expect(source).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              requiredValue: { type: "string" },
              optionalCount: { type: "number" },
            },
            required: ["requiredValue"],
          },
        },
        optionalNote: { type: "string" },
      },
      required: ["id", "items"],
    });
  });
});

describe("runCodexStructuredEvaluation", () => {
  test("maps valid structured output and JSONL session metadata", async () => {
    process.env.QUACK_SENTINEL_SECRET = "must-not-cross-process-boundary";
    process.env.AZURE_OPENAI_API_KEY = "selected-provider-credential";
    const calls = installSpawn((child, call) => emitSuccess(child, call, '{"ok":true}'));
    const result = await runCodexStructuredEvaluation(request(), config);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.value).toEqual({ ok: true });
    expect(result.sessionId).toBe("eval-session-1");
    expect(result.turnsUsed).toBe(1);
    const call = calls.find((entry) => entry.command === "codex")!;
    expect(call.options.cwd).toBe("C:/demo/worktree");
    expect(call.options.env.CODEX_HOME).toBe("C:/Users/demo/.codex-headless");
    expect(call.options.env.AZURE_OPENAI_API_KEY).toBe("selected-provider-credential");
    expect(call.options.env.QUACK_SENTINEL_SECRET).toBeUndefined();
    expect(call.child.stdin.written).toBe("Return only JSON.\n\nEvaluate this artifact.");
    expect(fs.existsSync(call.args[call.args.indexOf("--output-schema") + 1])).toBe(false);
  });

  test("fails closed when the last message violates the stage parser", async () => {
    installSpawn((child, call) => emitSuccess(child, call, '{"wrong":true}'));
    const result = await runCodexStructuredEvaluation(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("parse_failed");
  });

  test("contains malformed protocol output", async () => {
    installSpawn((child) => {
      child.stdout.emit("data", "not-json\n");
      child.emit("close", 0, null);
    });
    const result = await runCodexStructuredEvaluation(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("protocol_error");
  });

  test("contains non-zero exits and stderr diagnostics", async () => {
    installSpawn((child) => {
      child.stderr.emit("data", "authentication unavailable");
      child.emit("close", 2, null);
    });
    const result = await runCodexStructuredEvaluation(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
    expect(result.exitCode).toBe(2);
    expect(result.stderrTail).toContain("authentication unavailable");
  });

  test("rejects any read-only evaluator tree mutation", async () => {
    let probe = 0;
    _setCodexStructuredWorkspaceProbeFn(() => {
      probe += 1;
      return Promise.resolve(
        probe === 1
          ? cleanSnapshot
          : {
              ...cleanSnapshot,
              entries: { "src/tampered.ts": { status: " M", digest: "changed" } },
            },
      );
    });
    installSpawn((child, call) => emitSuccess(child, call, '{"ok":true}'));
    const result = await runCodexStructuredEvaluation(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("tree_mutated");
    expect(result.message).toContain("src/tampered.ts");
  });

  test("tree-kills a timed-out evaluator", async () => {
    const calls = installSpawn(() => {
      // Never closes.
    });
    const short = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      timeoutMs: 20,
    });
    const result = await runCodexStructuredEvaluation(request(), short);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("timeout");
    const codexChild = calls.find((entry) => entry.command === "codex")!.child;
    expect(codexChild.killed || calls.some((entry) => entry.command === "taskkill")).toBe(true);
  });
});
