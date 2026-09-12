import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, TaskContext } from "../../src/core/types";
import { AdapterAgentConfigSchema } from "../../src/core/adapter-schema";
import { codexShellEnvironmentPolicyArgs } from "../../src/llm/codex-process-security";

const mockVerifyBeforeStop: jest.MockedFunction<
  typeof import("../../src/hooks/verify-before-stop").verifyBeforeStop
> = jest.fn();
jest.mock("../../src/hooks/verify-before-stop", () => ({
  verifyBeforeStop: (
    ...args: Parameters<typeof import("../../src/hooks/verify-before-stop").verifyBeforeStop>
  ): ReturnType<typeof import("../../src/hooks/verify-before-stop").verifyBeforeStop> =>
    mockVerifyBeforeStop(...args),
}));

import {
  _setCodexDescendantContainmentFn,
  _setCodexDependencyRefreshFn,
  _setCodexDeniedPathGuardFactory,
  _setCodexTrustedExecutableResolverFn,
  _setCodexWorkerPlatform,
  _setCodexWorkerSpawnFn,
  _setWorkspaceProbeFn,
  buildCodexWorkerArgs,
  changedPaths,
  type SpawnFn,
  type WorkspaceSnapshot,
} from "../../src/worker/codex-agent-worker";
import { runAgent } from "../../src/worker/agent-worker";

const ORIGINAL_QUACK_SENTINEL = process.env.QUACK_SENTINEL_SECRET;
const ORIGINAL_AZURE_CREDENTIAL = process.env.AZURE_OPENAI_API_KEY;
const ORIGINAL_SYSTEM_ROOT = process.env.SYSTEMROOT;
const TRUSTED_CODEX_PATH =
  process.platform === "win32" ? "C:\\trusted-tools\\codex.exe" : "/trusted-tools/codex";

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
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"] | "ignore";
    windowsHide: boolean;
    detached?: boolean;
  };
  child: FakeChild;
}

function installSpawn(script: (child: FakeChild, call: SpawnCall) => void): SpawnCall[] {
  const calls: SpawnCall[] = [];
  _setCodexWorkerSpawnFn(((command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    if (path.win32.basename(command).toLowerCase() !== "taskkill.exe") {
      setImmediate(() => script(child, call));
    }
    return child as unknown as ChildProcess;
  }) as SpawnFn);
  return calls;
}

function snapshot(
  entries: WorkspaceSnapshot["entries"] = {},
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    head: "abc123",
    branch: "quack/TASK-008",
    entries,
    ...overrides,
  };
}

function installSnapshots(...snapshots: WorkspaceSnapshot[]): void {
  let index = 0;
  _setWorkspaceProbeFn(() => {
    const result = snapshots[Math.min(index, snapshots.length - 1)];
    index += 1;
    return Promise.resolve(result);
  });
}

function makeAdapter(agentOverrides: Partial<AdapterConfig["agent"]> = {}): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "space-shooter-demo",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      runner: "codex-cli",
      model: "gpt-5.6-terra",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 75,
      maxBudgetPerTask: 6,
      maxRetries: 1,
      codex: {
        binaryPath: "codex",
        sandbox: "workspace-write",
        codexHome: "C:/Users/demo/.codex-headless",
        provider: "azure",
        timeoutMs: 1_000,
      },
      ...agentOverrides,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env", ".quack/adapter.json"],
      allowedBashPatterns: ["npm test *", "git status *"],
      deniedBashPatterns: ["git push *", "rm -rf *"],
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
  };
  return {
    config,
    projectRoot: process.cwd(),
    conventionsDoc: "Keep game state deterministic.",
    judgeCriteria: "",
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

function makeContext(): TaskContext {
  return {
    taskSpec: "# TASK-008: Deterministic randomness\n\n## Problem Statement\nSeed the game.",
    taskSpecPath: "docs/tasks/TASK-008.md",
    conventions: {},
    conventionsSummary: "Deterministic state only.",
    relevantFiles: [],
    relatedPatterns: [],
    existingTests: [],
    claudeMd: [],
  };
}

function emitSuccessfulRun(child: FakeChild): void {
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "thread.started", thread_id: "019f-demo-session" })}\n`,
  );
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Implemented deterministic RNG." } })}\n`,
  );
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })}\n`,
  );
  child.emit("close", 0, null);
}

beforeEach(() => {
  process.env.SYSTEMROOT ??= "C:\\Windows";
  _setCodexTrustedExecutableResolverFn(() => TRUSTED_CODEX_PATH);
  _setCodexWorkerPlatform("linux");
  _setCodexDescendantContainmentFn(() => Promise.resolve());
  _setCodexDependencyRefreshFn(() => Promise.resolve({ success: true, stepsRun: 0, errors: [] }));
  _setCodexDeniedPathGuardFactory(() =>
    Promise.resolve({
      finish: () => Promise.resolve({ violations: [], restored: true }),
    }),
  );
  mockVerifyBeforeStop.mockReset();
  mockVerifyBeforeStop.mockResolvedValue({
    canStop: true,
    feedback: "VERIFICATION PASSED",
    verification: {
      allPassed: true,
      commands: [{ name: "tests", passed: true, output: "ok" }],
      conventionChecks: [],
    },
  });
  installSnapshots(snapshot(), snapshot());
});

afterEach(() => {
  _setCodexDescendantContainmentFn(undefined);
  _setCodexDependencyRefreshFn(undefined);
  _setCodexDeniedPathGuardFactory(undefined);
  _setCodexWorkerPlatform(undefined);
  _setCodexWorkerSpawnFn(undefined);
  _setCodexTrustedExecutableResolverFn(undefined);
  _setWorkspaceProbeFn(undefined);
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
  if (ORIGINAL_SYSTEM_ROOT === undefined) {
    delete process.env.SYSTEMROOT;
  } else {
    process.env.SYSTEMROOT = ORIGINAL_SYSTEM_ROOT;
  }
});

describe("Codex implementation worker configuration", () => {
  test("defaults existing adapters to the Claude SDK", () => {
    const parsed = AdapterAgentConfigSchema.parse({});
    expect(parsed.runner).toBe("claude-sdk");
    expect(parsed.codex).toBeUndefined();
  });

  test("accepts only the workspace-write sandbox and rejects argv injection fields", () => {
    expect(
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { sandbox: "workspace-write", provider: "azure" },
      }).codex,
    ).toEqual(
      expect.objectContaining({
        binaryPath: "codex",
        sandbox: "workspace-write",
        timeoutMs: 1_800_000,
      }),
    );
    expect(() =>
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { sandbox: "danger-full-access" },
      }),
    ).toThrow();
    expect(() =>
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
      }),
    ).toThrow();
    expect(() =>
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { provider: 'azure" --add-dir C:/outside' },
      }),
    ).toThrow();
    expect(
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { credentialEnvVar: "AZURE_OPENAI_API_KEY" },
      }).codex?.credentialEnvVar,
    ).toBe("AZURE_OPENAI_API_KEY");
    expect(() =>
      AdapterAgentConfigSchema.parse({
        runner: "codex-cli",
        codex: { credentialEnvVar: "QUACK_SERVICE_TOKEN" },
      }),
    ).toThrow();
  });

  test("builds an exact safe fresh and resume argv", () => {
    const adapter = makeAdapter();
    const config = adapter.config.agent.codex!;
    const fresh = buildCodexWorkerArgs({
      config,
      projectRoot: adapter.projectRoot,
      model: "gpt-5.6-terra",
    });
    expect(fresh).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-c",
      'model_provider="azure"',
      ...codexShellEnvironmentPolicyArgs(),
      "-m",
      "gpt-5.6-terra",
      "--cd",
      process.cwd(),
      "--json",
      "-",
    ]);
    expect(fresh).not.toContain("--add-dir");
    expect(fresh).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    expect(
      buildCodexWorkerArgs({
        config,
        projectRoot: adapter.projectRoot,
        model: "gpt-5.6-terra",
        resumeSessionId: "019f-session-1",
      }).slice(-3),
    ).toEqual(["resume", "019f-session-1", "-"]);
    expect(() =>
      buildCodexWorkerArgs({
        config,
        projectRoot: adapter.projectRoot,
        model: "gpt-5.6-terra",
        resumeSessionId: "--last",
      }),
    ).toThrow("unsupported characters");
  });
});

describe("Codex implementation worker execution", () => {
  test("routes runAgent through Codex, maps JSONL/session/files, and reruns verification", async () => {
    let guardFinishes = 0;
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    process.env.QUACK_SENTINEL_SECRET = "must-not-cross-process-boundary";
    process.env.AZURE_OPENAI_API_KEY = "selected-provider-credential";
    installSnapshots(
      snapshot(),
      snapshot({
        "src/game.ts": { status: " M", digest: "changed" },
        "tests/rng.test.ts": { status: "??", digest: "new" },
      }),
    );
    const calls = installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("success");
    expect(result.claudeSessionId).toBe("019f-demo-session");
    expect(result.turnsUsed).toBe(1);
    expect(result.totalCostUsd).toBe(0);
    expect(result.filesModified).toEqual(["src/game.ts"]);
    expect(result.filesCreated).toEqual(["tests/rng.test.ts"]);
    expect(result.messages[0]?.content).toContain("deterministic RNG");
    expect(result.verification?.allPassed).toBe(true);
    expect(mockVerifyBeforeStop).toHaveBeenCalledTimes(1);

    const call = calls[0];
    expect(call.command).toBe("/usr/bin/unshare");
    expect(call.options.cwd).toBe(process.cwd());
    expect(call.options.env.CODEX_HOME).toBe("C:/Users/demo/.codex-headless");
    expect(call.options.env.AZURE_OPENAI_API_KEY).toBe("selected-provider-credential");
    expect(call.options.env.QUACK_SENTINEL_SECRET).toBeUndefined();
    expect(call.args.slice(0, 7)).toEqual([
      "--user",
      "--map-current-user",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--mount-proc",
      "--",
    ]);
    expect(call.args.slice(7)).toEqual([
      TRUSTED_CODEX_PATH,
      ...buildCodexWorkerArgs({
        config: makeAdapter().config.agent.codex!,
        projectRoot: process.cwd(),
        model: "gpt-5.6-terra",
      }),
    ]);
    expect(call.child.stdin.written).toContain("TASK-008");
    expect(call.child.stdin.written).toContain("workspace-write sandbox");
    expect(call.child.stdin.written).toContain("npm test");
    expect(call.child.stdin.written).toContain("Denied paths are quarantined during this turn");
    expect(call.child.stdin.written).toContain(
      "restores the original directory before mandatory post-run verification",
    );
    expect(result.messages.at(-1)?.content).toContain("maxTurns=75 and maxBudgetUsd=6");
    expect(result.messages.at(-1)?.content).toContain("not enforced");
    expect(guardFinishes).toBe(1);
  });

  test("restores disposable paths, safely refreshes changed manifests, then verifies", async () => {
    const order: string[] = [];
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          order.push("guard-restored");
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    const refresh = jest.fn(() => {
      order.push("dependencies-refreshed");
      return Promise.resolve({ success: true, stepsRun: 1, errors: [] });
    });
    _setCodexDependencyRefreshFn(refresh);
    mockVerifyBeforeStop.mockImplementation(() => {
      order.push("verified");
      return Promise.resolve({
        canStop: true,
        feedback: "VERIFICATION PASSED",
        verification: {
          allPassed: true,
          commands: [{ name: "tests", passed: true, output: "ok" }],
          conventionChecks: [],
        },
      });
    });
    installSnapshots(
      snapshot(),
      snapshot({ "package.json": { status: " M", digest: "worker-change" } }),
      snapshot({ "package.json": { status: " M", digest: "worker-change" } }),
    );
    installSpawn((child) => emitSuccessfulRun(child));
    const adapter = makeAdapter();
    adapter.config.sandbox.writablePaths.push("package.json");

    const result = await runAgent("TASK-008", makeContext(), adapter, {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("success");
    expect(refresh).toHaveBeenCalledWith(process.cwd(), ["package.json"], undefined);
    expect(order).toEqual(["guard-restored", "dependencies-refreshed", "verified"]);
  });

  test("blocks verification when safe dependency refresh fails", async () => {
    const refresh = jest.fn(() =>
      Promise.resolve({
        success: false,
        stepsRun: 0,
        errors: [{ step: "Safe dependency refresh (.)", message: "unsafe project .npmrc" }],
      }),
    );
    _setCodexDependencyRefreshFn(refresh);
    installSnapshots(
      snapshot(),
      snapshot({ "package-lock.json": { status: " M", digest: "worker-change" } }),
    );
    installSpawn((child) => emitSuccessfulRun(child));
    const adapter = makeAdapter();
    adapter.config.sandbox.writablePaths.push("package-lock.json");

    const result = await runAgent("TASK-008", makeContext(), adapter, {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("Safe dependency refresh failed");
    expect(result.error).toContain("unsafe project .npmrc");
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("enters dependency recovery before verifying unrelated source changes", async () => {
    const refresh = jest.fn(() => Promise.resolve({ success: true, stepsRun: 0, errors: [] }));
    _setCodexDependencyRefreshFn(refresh);
    installSnapshots(
      snapshot(),
      snapshot({ "src/game.ts": { status: " M", digest: "worker-change" } }),
    );
    installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("success");
    expect(refresh).toHaveBeenCalledWith(process.cwd(), [], undefined);
    expect(mockVerifyBeforeStop).toHaveBeenCalledTimes(1);
  });

  test("blocks verification when recovery fails without a newly changed manifest", async () => {
    const refresh = jest.fn(() =>
      Promise.resolve({
        success: false,
        stepsRun: 0,
        errors: [
          {
            step: "dependency refresh lock",
            message: "abandoned transaction could not be recovered",
          },
        ],
      }),
    );
    _setCodexDependencyRefreshFn(refresh);
    installSnapshots(
      snapshot(),
      snapshot({ "src/game.ts": { status: " M", digest: "worker-change" } }),
    );
    installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("Safe dependency refresh failed");
    expect(result.error).toContain("abandoned transaction could not be recovered");
    expect(refresh).toHaveBeenCalledWith(process.cwd(), [], undefined);
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("describes configured disposable dependency mirrors without relaxing other denied paths", async () => {
    const adapter = makeAdapter();
    adapter.config.sandbox.disposablePaths = ["node_modules/"];
    const calls = installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), adapter, {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("success");
    const prompt = calls[0].child.stdin.written;
    expect(prompt).toContain("Disposable paths available for this turn: node_modules/");
    expect(prompt).toContain("independent mirrors");
    expect(prompt).toContain("Quack discards their changes");
    expect(prompt).toContain("Other denied paths remain quarantined; do not recreate them");
  });

  test.each([
    ["default", undefined, "codex"],
    ["configured", "C:/configured/codex.exe", "C:/configured/codex.exe"],
  ])(
    "resolves the %s Codex binary outside the worktree before launch",
    async (_label, binaryPath, expected) => {
      const resolver = jest.fn(() => TRUSTED_CODEX_PATH);
      _setCodexTrustedExecutableResolverFn(resolver);
      installSpawn((child) => emitSuccessfulRun(child));
      const adapter = binaryPath
        ? makeAdapter({
            codex: {
              binaryPath,
              sandbox: "workspace-write",
              timeoutMs: 1_000,
            },
          })
        : makeAdapter();

      const result = await runAgent("TASK-008", makeContext(), adapter, {
        skipMcpServers: true,
      });

      expect(result.outcome).toBe("success");
      expect(resolver).toHaveBeenCalledWith(expected, process.cwd(), "Codex CLI");
    },
  );

  test("contains and verifies descendants before restoring quarantined paths", async () => {
    const order: string[] = [];
    let releaseContainment!: () => void;
    let markContainmentStarted!: () => void;
    const containmentStarted = new Promise<void>((resolve) => {
      markContainmentStarted = resolve;
    });
    const containmentReleased = new Promise<void>((resolve) => {
      releaseContainment = resolve;
    });
    _setCodexDescendantContainmentFn(async (evidence) => {
      expect(evidence).toEqual({
        pid: 4242,
        platform: "linux",
        interrupted: false,
        linuxPidNamespace: true,
        windowsCompletionObserved: false,
      });
      order.push("containment-started");
      markContainmentStarted();
      await containmentReleased;
      order.push("containment-verified");
    });
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          order.push("guard-restored");
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    installSpawn((child) => emitSuccessfulRun(child));

    const run = runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });
    await containmentStarted;

    expect(order).toEqual(["containment-started"]);
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
    releaseContainment();

    const result = await run;
    expect(result.outcome).toBe("success");
    expect(order).toEqual(["containment-started", "containment-verified", "guard-restored"]);
  });

  test("leaves protected paths quarantined when descendant absence cannot be proved", async () => {
    let guardFinishes = 0;
    _setCodexDescendantContainmentFn(() =>
      Promise.reject(new Error("process group 4242 still contains a background child")),
    );
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("protected paths remain quarantined");
    expect(result.error).toContain("background child");
    expect(guardFinishes).toBe(0);
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("rejects a normal Windows wrapper exit without its tree-empty evidence", async () => {
    let guardFinishes = 0;
    _setCodexWorkerPlatform("win32");
    _setCodexDescendantContainmentFn(undefined);
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    const calls = installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(calls[0]?.command.toLowerCase()).toContain(
      "\\system32\\windowspowershell\\v1.0\\powershell.exe",
    );
    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("protected paths remain quarantined");
    expect(result.error).toContain("did not prove that all descendants exited");
    expect(guardFinishes).toBe(0);
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("does not restore quarantined paths after an interrupted Windows tree wait", async () => {
    let guardFinishes = 0;
    process.env.QUACK_SENTINEL_SECRET = "must-not-reach-taskkill";
    _setCodexWorkerPlatform("win32");
    _setCodexDescendantContainmentFn(undefined);
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    const calls = installSpawn(() => {
      // The Windows wrapper remains alive because a descendant is still live.
    });
    const adapter = makeAdapter({
      codex: {
        binaryPath: "codex",
        sandbox: "workspace-write",
        timeoutMs: 20,
      },
    });

    const result = await runAgent("TASK-008", makeContext(), adapter, {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.error).toContain("protected paths remain quarantined");
    const taskkillCall = calls.find(
      (call) => path.win32.basename(call.command).toLowerCase() === "taskkill.exe",
    );
    expect(taskkillCall).toBeDefined();
    expect(path.win32.isAbsolute(taskkillCall!.command)).toBe(true);
    expect(path.win32.normalize(taskkillCall!.options.cwd)).toBe(
      path.win32.dirname(path.win32.normalize(taskkillCall!.command)),
    );
    expect(taskkillCall!.options.env.QUACK_SENTINEL_SECRET).toBeUndefined();
    expect(guardFinishes).toBe(0);
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("passes retry feedback over stdin and resumes the exact session", async () => {
    const calls = installSpawn((child) => emitSuccessfulRun(child));
    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
      resumeSessionId: "019f-prior-session",
      retryFeedback: "Fix the replay hash mismatch only.",
    });
    expect(result.outcome).toBe("success");
    const call = calls[0];
    expect(call.args.slice(-3)).toEqual(["resume", "019f-prior-session", "-"]);
    expect(call.child.stdin.written).toBe("Fix the replay hash mismatch only.");
  });

  test("emits optional verification disposition metadata for judge and monitor evidence", async () => {
    mockVerifyBeforeStop.mockResolvedValue({
      canStop: true,
      feedback: "VERIFICATION PASSED",
      verification: {
        allPassed: true,
        commands: [
          {
            name: "browser-smoke",
            passed: false,
            required: false,
            status: "optional-unavailable",
            output: "TASK-006 browser harness is not integrated",
          },
        ],
        conventionChecks: [],
      },
    });
    installSnapshots(snapshot(), snapshot({ "src/game.ts": { status: " M", digest: "changed" } }));
    installSpawn((child) => emitSuccessfulRun(child));
    const emit = jest.fn<void, [string, unknown]>();
    const events = {
      emit,
    } as unknown as import("../../src/monitor/event-emitter").IEventWriter;

    const result = await runAgent(
      "TASK-008",
      makeContext(),
      makeAdapter(),
      { skipMcpServers: true },
      events,
    );

    expect(result.outcome).toBe("success");
    expect(emit).toHaveBeenCalledWith("verification_result", {
      allPassed: true,
      commands: [
        {
          name: "browser-smoke",
          passed: false,
          required: false,
          status: "optional-unavailable",
        },
      ],
    });
  });

  test("fails closed on malformed or incomplete JSONL", async () => {
    let guardFinishes = 0;
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    installSpawn((child) => {
      child.stdout.emit("data", "not-json\n");
      child.emit("close", 0, null);
    });
    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });
    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("malformed JSONL");
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
    expect(guardFinishes).toBe(1);
  });

  test("finishes denied-path restoration when process creation fails", async () => {
    let guardFinishes = 0;
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    _setCodexWorkerSpawnFn((() => {
      throw new Error("spawn denied");
    }) as SpawnFn);

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("spawn denied");
    expect(guardFinishes).toBe(1);
  });

  test("fails closed when Codex changes branch identity or a denied path", async () => {
    installSnapshots(
      snapshot(),
      snapshot(
        { ".env": { status: " M", digest: "secret-change" } },
        { head: "def456", branch: "main" },
      ),
    );
    installSpawn((child) => emitSuccessfulRun(child));
    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });
    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("changed git HEAD");
    expect(result.error).toContain("changed the checked-out branch");
    expect(result.error).toContain("denied paths");
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("fails closed and skips verification when an ignored denied path was recreated", async () => {
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () =>
          Promise.resolve({
            violations: ["node_modules/.cache/model-write"],
            restored: true,
          }),
      }),
    );
    installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain(
      "Codex wrote denied path (restored): node_modules/.cache/model-write",
    );
    expect(mockVerifyBeforeStop).not.toHaveBeenCalled();
  });

  test("refuses to spawn when denied-path secrecy cannot be guaranteed", async () => {
    _setCodexDeniedPathGuardFactory(() =>
      Promise.reject(
        new Error("secret-bearing denied path .env.local cannot be guaranteed unreadable"),
      ),
    );
    const calls = installSpawn((child) => emitSuccessfulRun(child));

    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("cannot be guaranteed unreadable");
    expect(calls).toHaveLength(0);
  });

  test("fails when deterministic verification refuses stop", async () => {
    mockVerifyBeforeStop.mockResolvedValue({
      canStop: false,
      feedback: "STOP BLOCKED: tests failed",
      verification: {
        allPassed: false,
        commands: [{ name: "tests", passed: false, output: "FAIL" }],
        conventionChecks: [],
      },
    });
    installSpawn((child) => emitSuccessfulRun(child));
    const result = await runAgent("TASK-008", makeContext(), makeAdapter(), {
      skipMcpServers: true,
    });
    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("STOP BLOCKED");
    expect(result.verification?.allPassed).toBe(false);
  });

  test("tree-kills a timed-out Codex process", async () => {
    let guardFinishes = 0;
    _setCodexDeniedPathGuardFactory(() =>
      Promise.resolve({
        finish: () => {
          guardFinishes += 1;
          return Promise.resolve({ violations: [], restored: true });
        },
      }),
    );
    const calls = installSpawn(() => {
      // Intentionally never closes.
    });
    const adapter = makeAdapter({
      codex: {
        binaryPath: "codex",
        sandbox: "workspace-write",
        timeoutMs: 20,
      },
    });
    const result = await runAgent("TASK-008", makeContext(), adapter, {
      skipMcpServers: true,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.error).toContain("20ms");
    const codexChild = calls[0].child;
    expect(
      codexChild.killed ||
        calls.some((call) => path.win32.basename(call.command).toLowerCase() === "taskkill.exe"),
    ).toBe(true);
    expect(guardFinishes).toBe(1);
  });
});

describe("changedPaths", () => {
  test("detects edits to already-dirty files by content fingerprint", () => {
    expect(
      changedPaths(
        snapshot({ "src/pre-dirty.ts": { status: " M", digest: "before" } }),
        snapshot({ "src/pre-dirty.ts": { status: " M", digest: "after" } }),
      ),
    ).toEqual(["src/pre-dirty.ts"]);
  });
});
