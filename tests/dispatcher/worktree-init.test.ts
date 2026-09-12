// ─── Worktree Init Tests ────────────────────────────────────────────

/* eslint-disable @typescript-eslint/require-await */
// Mock implementations are typed `Promise<ExecMockResult>`, so they're declared
// `async` for return-type inference even when the body is a single literal.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";

type ExecMockResult = { stdout: string; stderr: string };

// Module-level mutable function — each test reassigns this to control behavior
let mockExecImpl: (command: string, options: unknown) => Promise<ExecMockResult> = async () => ({
  stdout: "",
  stderr: "",
});

import {
  _setWorktreeInitAtomicFilePublisher,
  _setWorktreeInitCommandRunner,
  _setWorktreeInitDependencyRefreshDirectorySync,
  _setWorktreeInitDependencyRefreshRename,
  _setWorktreeInitEnvironmentCleanup,
  changedDependencyManifestPaths,
  runPostWorkerDependencyRefresh,
  runWorktreeInit,
} from "../../src/dispatcher/worktree-init.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";
import type { ContainedWorktreeInitInput } from "../../src/dispatcher/worktree-init-process.js";

// ── Helpers ─────────────────────────────────────────────────────────

function setMockExecSuccess(): void {
  mockExecImpl = async () => ({ stdout: "", stderr: "" });
}

function setMockExecFailure(exitCode: number, stderrMsg: string): void {
  mockExecImpl = async () => {
    const err = Object.assign(new Error("Command failed"), {
      code: exitCode,
      stderr: stderrMsg,
      stdout: "",
    });
    throw err;
  };
}

async function dependencyRefreshLockPath(projectRoot: string): Promise<string> {
  const canonical = await fs.realpath(projectRoot);
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const key = createHash("sha256").update(identity).digest("hex");
  return path.join(os.tmpdir(), "quack-dependency-refresh", key);
}

async function cleanupDependencyRefreshRuntime(projectRoot: string): Promise<void> {
  const lockPath = await dependencyRefreshLockPath(projectRoot);
  const runtimeRoot = path.dirname(lockPath);
  const key = path.basename(lockPath);
  const entries = await fs.readdir(runtimeRoot).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry === key || entry.startsWith(`${key}.`))
      .map((entry) => fs.rm(path.join(runtimeRoot, entry), { recursive: true, force: true })),
  );
}

async function writeLegacyAbandonedOwner(
  transactionDirectory: string,
  canonicalRoot: string,
): Promise<void> {
  const ownerPath = path.join(transactionDirectory, "owner.json");
  await fs.writeFile(ownerPath, JSON.stringify({ version: 1, pid: process.pid, canonicalRoot }));
  const expired = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(ownerPath, expired, expired);
  await fs.writeFile(path.join(transactionDirectory, "ABANDONED"), "recovery required\n");
}

describe("worktree-init", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-init-test-"));
    setMockExecSuccess();
    _setWorktreeInitCommandRunner(async (input) => {
      const renderedCommand = input.command ?? [input.executable, ...(input.args ?? [])].join(" ");
      try {
        const result = await mockExecImpl(renderedCommand, input);
        return {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: false,
          descendantsContained: true,
        };
      } catch (error: unknown) {
        const failure = error as {
          code?: number;
          stderr?: string;
          stdout?: string;
          message?: string;
        };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message ?? String(error),
          timedOut: false,
          descendantsContained: true,
        };
      }
    });
  });

  afterEach(async () => {
    _setWorktreeInitAtomicFilePublisher(undefined);
    _setWorktreeInitCommandRunner(undefined);
    _setWorktreeInitDependencyRefreshDirectorySync(undefined);
    _setWorktreeInitDependencyRefreshRename(undefined);
    _setWorktreeInitEnvironmentCleanup(undefined);
    await cleanupDependencyRefreshRuntime(tmpDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Auto-discovery tests ─────────────────────────────────────────

  test("auto-discovery: discovers package.json at worktree root and runs npm ci when package-lock.json exists", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");

    const calledCommands: string[] = [];
    mockExecImpl = async (command: string) => {
      calledCommands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir);

    expect(result.success).toBe(true);
    expect(result.stepsRun).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(calledCommands).toHaveLength(1);
    expect(calledCommands[0]).toMatch(/npm-cli\.js ci --ignore-scripts --no-audit --no-fund$/);
  });

  test("auto-discovery: runs npm install when package-lock.json is absent", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    // No package-lock.json

    const calledCommands: string[] = [];
    mockExecImpl = async (command: string) => {
      calledCommands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir);

    expect(result.success).toBe(true);
    expect(result.stepsRun).toBe(1);
    expect(calledCommands[0]).toMatch(/npm-cli\.js install --ignore-scripts --no-audit --no-fund$/);
  });

  test("auto-discovery bypasses an npm shadow binary in the mutable cwd", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "npm.cmd"), "@echo compromised");
    let invocation: ContainedWorktreeInitInput | undefined;
    _setWorktreeInitCommandRunner(async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runWorktreeInit(tmpDir);

    expect(result.success).toBe(true);
    expect(invocation?.command).toBeUndefined();
    expect(await fs.realpath(invocation!.executable!)).toBe(await fs.realpath(process.execPath));
    expect(invocation?.args?.[0]).toMatch(/npm-cli\.js$/);
    expect(invocation?.args).not.toContain(path.join(tmpDir, "npm.cmd"));
  });

  test("auto-discovery: discovers nested package.json up to 3 levels deep", async () => {
    // Root level (depth 0)
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");

    // 1 level deep (depth 1)
    const frontendDir = path.join(tmpDir, "frontend");
    await fs.mkdir(frontendDir);
    await fs.writeFile(path.join(frontendDir, "package.json"), "{}");
    await fs.writeFile(path.join(frontendDir, "package-lock.json"), "{}");

    // 2 levels deep (depth 2)
    const componentsDir = path.join(frontendDir, "components");
    await fs.mkdir(componentsDir);
    await fs.writeFile(path.join(componentsDir, "package.json"), "{}");
    await fs.writeFile(path.join(componentsDir, "package-lock.json"), "{}");

    const result = await runWorktreeInit(tmpDir);

    expect(result.success).toBe(true);
    expect(result.stepsRun).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  test("auto-discovery: does not discover package.json inside node_modules", async () => {
    // A non-excluded package.json at root
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");

    // A package.json inside node_modules (should be excluded)
    const nodeModulesDir = path.join(tmpDir, "node_modules", "some-pkg");
    await fs.mkdir(nodeModulesDir, { recursive: true });
    await fs.writeFile(path.join(nodeModulesDir, "package.json"), "{}");

    const result = await runWorktreeInit(tmpDir);

    // Only root package.json should be discovered
    expect(result.stepsRun).toBe(1);
  });

  test("auto-discovery: does not discover package.json more than 3 levels deep", async () => {
    // root/a/b/c/d/package.json — depth 4, exceeds MAX_DISCOVERY_DEPTH=3
    const deepDir = path.join(tmpDir, "a", "b", "c", "d");
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(deepDir, "package.json"), "{}");

    const result = await runWorktreeInit(tmpDir);

    // Should discover nothing (no package.json within 3 levels)
    expect(result.stepsRun).toBe(0);
    expect(result.success).toBe(true);
  });

  // ── Explicit-config tests ────────────────────────────────────────

  test("explicit-config: runs only configured steps, skips auto-discovery", async () => {
    // No package.json files in the directory
    const calledCommands: string[] = [];
    mockExecImpl = async (command: string) => {
      calledCommands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, [
      { command: "pip install -r requirements.txt", cwd: "." },
    ]);

    expect(result.success).toBe(true);
    expect(result.stepsRun).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(calledCommands).toHaveLength(1);
    expect(calledCommands[0]).toBe("pip install -r requirements.txt");
    expect(calledCommands[0]).not.toContain("npm");
  });

  test("explicit-config: resolves string steps as plain shell commands", async () => {
    const calledCommands: string[] = [];
    mockExecImpl = async (command: string) => {
      calledCommands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, ["yarn install"]);

    expect(result.success).toBe(true);
    expect(result.stepsRun).toBe(1);
    expect(calledCommands[0]).toBe("yarn install");
  });

  // ── Failure handling tests ───────────────────────────────────────

  test("failure handling: npm ci fails — returns structured error, does not throw", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    setMockExecFailure(1, "npm ERR! network timeout");

    const result = await runWorktreeInit(tmpDir);

    expect(result.success).toBe(false);
    expect(result.stepsRun).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(
      expect.objectContaining({
        step: expect.stringContaining("npm ci"),
        message: expect.any(String),
        exitCode: 1,
      }),
    );
  });

  test("failure handling: first step fails but remaining steps still run", async () => {
    // Two package.json files
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");

    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(subDir, "package.json"), "{}");
    await fs.writeFile(path.join(subDir, "package-lock.json"), "{}");

    // First call fails, second succeeds
    let callCount = 0;
    mockExecImpl = async (_command: string) => {
      callCount++;
      if (callCount === 1) {
        const err = Object.assign(new Error("Command failed"), {
          code: 1,
          stderr: "npm ERR! network timeout",
          stdout: "",
        });
        throw err;
      }
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir);

    expect(result.stepsRun).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  test("failure handling: events are emitted correctly on step failure", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    setMockExecFailure(1, "npm ERR! network timeout");

    const emittedEvents: Array<{ stage: string; payload: unknown }> = [];
    const mockEvents: IEventWriter = {
      sessionId: "test-session",
      taskId: "TASK-TEST",
      project: "test",
      emit: (stage, payload) => {
        emittedEvents.push({ stage: stage as string, payload });
      },
      recordSession: () => {
        /* no-op */
      },
    };

    const result = await runWorktreeInit(tmpDir, undefined, mockEvents);

    expect(result.success).toBe(false);

    const stages = emittedEvents.map((e) => e.stage);
    expect(stages).toContain("worktree_init_step_failed");
    expect(stages).toContain("worktree_init_complete");

    const completeEvent = emittedEvents.find((e) => e.stage === "worktree_init_complete");
    expect(completeEvent?.payload).toEqual(expect.objectContaining({ success: false }));
  });

  test("explicit empty config disables initialization instead of auto-discovering", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const commands: string[] = [];
    mockExecImpl = async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, []);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    expect(commands).toHaveLength(0);
  });

  test("rejects a structured cwd that lexically escapes the worktree", async () => {
    const commands: string[] = [];
    mockExecImpl = async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, [
      { command: "npm ci", cwd: "..", label: "outside" },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("escapes the worktree");
    expect(commands).toHaveLength(0);
  });

  test("rejects absolute cwd values even when they point inside the worktree", async () => {
    const commands: string[] = [];
    mockExecImpl = async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, [
      { command: "npm ci", cwd: tmpDir, label: "absolute cwd" },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("must be worktree-relative");
    expect(commands).toHaveLength(0);
  });

  test("rejects a structured cwd that escapes through a symlink or junction", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-init-outside-"));
    const alias = path.join(tmpDir, "outside-alias");
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = await runWorktreeInit(tmpDir, [
        { command: "npm ci", cwd: "outside-alias", label: "aliased outside" },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors[0]?.message).toContain("resolves outside the worktree");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("keeps contained aliases valid for ordinary initialization steps", async () => {
    const realDirectory = path.join(tmpDir, "real-directory");
    const aliasDirectory = path.join(tmpDir, "contained-alias");
    await fs.mkdir(realDirectory);
    await fs.symlink(
      realDirectory,
      aliasDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    let observedCwd: string | undefined;
    _setWorktreeInitCommandRunner(async (input) => {
      observedCwd = input.cwd;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runWorktreeInit(tmpDir, [
      { command: "custom-init", cwd: "contained-alias" },
    ]);

    expect(result.success).toBe(true);
    expect(observedCwd).toBe(await fs.realpath(realDirectory));
  });

  test("passes a canonical cwd with spaces without interpolating it into the command", async () => {
    const nested = path.join(tmpDir, "directory with spaces");
    await fs.mkdir(nested);
    let observedOptions: { command?: string; cwd?: string } = {};
    mockExecImpl = async (command, options) => {
      observedOptions = {
        command,
        cwd: (options as { cwd: string }).cwd,
      };
      return { stdout: "", stderr: "" };
    };

    const result = await runWorktreeInit(tmpDir, [
      { command: "custom-init", cwd: "directory with spaces" },
    ]);

    expect(result.success).toBe(true);
    expect(observedOptions.command).toBe("custom-init");
    expect(observedOptions.cwd).toBe(await fs.realpath(nested));
  });

  test("translates recognized explicit npm installs to trusted structured argv", async () => {
    await fs.writeFile(path.join(tmpDir, "npm.cmd"), "@echo compromised");
    let invocation: ContainedWorktreeInitInput | undefined;
    _setWorktreeInitCommandRunner(async (input) => {
      invocation = input;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runWorktreeInit(tmpDir, [
      { command: "npm ci --ignore-scripts --no-audit --no-fund", cwd: "." },
    ]);

    expect(result.success).toBe(true);
    expect(invocation?.command).toBeUndefined();
    expect(await fs.realpath(invocation!.executable!)).toBe(await fs.realpath(process.execPath));
    expect(invocation?.args?.slice(1)).toEqual([
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  });

  test("strips ambient secrets and forces npm lifecycle scripts off", async () => {
    const secretName = "QUACK_WORKTREE_INIT_TEST_SECRET";
    const priorSecret = process.env[secretName];
    process.env[secretName] = "must-not-reach-install";
    let observedEnv: NodeJS.ProcessEnv | undefined;
    mockExecImpl = async (_command, options) => {
      observedEnv = (options as { env: NodeJS.ProcessEnv }).env;
      return { stdout: "", stderr: "" };
    };
    try {
      const result = await runWorktreeInit(tmpDir, [{ command: "npm ci" }]);

      expect(result.success).toBe(true);
      expect(observedEnv?.[secretName]).toBeUndefined();
      expect(observedEnv?.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
      expect(observedEnv?.NPM_CONFIG_AUDIT).toBe("false");
      expect(observedEnv?.NPM_CONFIG_USERCONFIG).toContain("quack-init-env-");
    } finally {
      if (priorSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = priorSecret;
    }
  });

  test("rejects NODE_OPTIONS before a trusted npm launch can load project code", async () => {
    const sentinel = path.join(tmpDir, "node-options-loaded.txt");
    const injector = path.join(tmpDir, "injector.cjs");
    await fs.writeFile(
      injector,
      `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed")`,
    );
    let calls = 0;
    _setWorktreeInitCommandRunner(async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runWorktreeInit(tmpDir, [
      {
        command: "npm ci --ignore-scripts --no-audit --no-fund",
        env: { NODE_OPTIONS: `--require=${injector}` },
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain(
      "Reserved worktree-init environment variable cannot be overridden: NODE_OPTIONS",
    );
    expect(calls).toBe(0);
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("event sink failures do not turn successful initialization into a throw", async () => {
    const throwingEvents: IEventWriter = {
      sessionId: "test-session",
      taskId: "TASK-TEST",
      project: "test",
      emit: () => {
        throw new Error("event store unavailable");
      },
      recordSession: () => undefined,
    };

    await expect(runWorktreeInit(tmpDir, [{ command: "npm ci" }], throwingEvents)).resolves.toEqual(
      { success: true, stepsRun: 1, errors: [] },
    );
  });

  test("reports temporary npm environment cleanup failure in the result and final event", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const events = {
      emit: (stage: string, payload: unknown) => emitted.push({ stage, payload }),
    } as unknown as IEventWriter;
    _setWorktreeInitEnvironmentCleanup(async (cleanupRoot) => {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      throw new Error("simulated cleanup refusal");
    });

    const result = await runWorktreeInit(tmpDir, undefined, events);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual({
      step: "temporary npm environment cleanup",
      message: "simulated cleanup refusal",
    });
    const completions = emitted.filter((event) => event.stage === "worktree_init_complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({ success: false, errorCount: 1 });
    expect(
      emitted.some(
        (event) =>
          event.stage === "worktree_init_step_failed" &&
          (event.payload as { step?: string }).step === "temporary npm environment cleanup",
      ),
    ).toBe(true);
  });

  test("stops launching steps when descendant containment cannot be proved", async () => {
    let calls = 0;
    _setWorktreeInitCommandRunner(async () => {
      calls += 1;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "process tree still live",
        timedOut: true,
        descendantsContained: false,
      };
    });

    const result = await runWorktreeInit(tmpDir, ["first", "second"]);

    expect(result.success).toBe(false);
    expect(result.stepsRun).toBe(1);
    expect(calls).toBe(1);
  });

  test("normalizes safe dependency manifests and drops absolute or escaping paths", () => {
    expect(
      changedDependencyManifestPaths([
        "package.json",
        "frontend\\package-lock.json",
        "./frontend/package-lock.json",
        "../package.json",
        "C:\\outside\\package.json",
        "src/app.ts",
      ]),
    ).toEqual(["frontend/package-lock.json", "package.json"]);
  });

  test("ignores changed dependency manifests inside generated or repository metadata trees", () => {
    expect(
      changedDependencyManifestPaths([
        "node_modules/demo/package.json",
        "dist/package-lock.json",
        "build/npm-shrinkwrap.json",
        ".git/package.json",
        "NoDe_MoDuLeS/demo/package.json",
        "packages/demo/package.json",
      ]),
    ).toEqual(["packages/demo/package.json"]);
  });

  test("post-worker refresh rejects an in-worktree package alias before journaling", async () => {
    const realPackage = path.join(tmpDir, "real-package");
    const aliasPackage = path.join(tmpDir, "alias-package");
    await fs.mkdir(realPackage);
    await fs.writeFile(path.join(realPackage, "package.json"), "{}");
    await fs.writeFile(path.join(realPackage, "package-lock.json"), "{}");
    await fs.symlink(realPackage, aliasPackage, process.platform === "win32" ? "junction" : "dir");
    let calls = 0;
    _setWorktreeInitCommandRunner(async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["alias-package/package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("uses a filesystem alias");
    expect(calls).toBe(0);
    await expect(fs.access(await dependencyRefreshLockPath(tmpDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("post-worker refresh runs only for changed manifests with sanitized npm ci", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const observed: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    mockExecImpl = async (command, options) => {
      observed.push({ command, env: (options as { env: NodeJS.ProcessEnv }).env });
      return { stdout: "", stderr: "" };
    };
    const skippedEvents: Array<{ stage: string; payload: unknown }> = [];
    const events = {
      emit: (stage: string, payload: unknown) => skippedEvents.push({ stage, payload }),
    } as unknown as IEventWriter;

    const skipped = await runPostWorkerDependencyRefresh(tmpDir, ["src/app.ts"], events);
    const refreshed = await runPostWorkerDependencyRefresh(tmpDir, [
      "package.json",
      "package-lock.json",
    ]);

    expect(skipped.stepsRun).toBe(0);
    expect(refreshed.success).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.command).toMatch(/npm-cli\.js ci --ignore-scripts --no-audit --no-fund$/);
    expect(observed[0]?.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe("true");
    expect(observed[0]?.env.NPM_CONFIG_CACHE).toContain("quack-init-env-");
    expect(observed[0]?.env.NPM_CONFIG_PREFIX).toContain("quack-init-env-");
    expect(observed[0]?.env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
    expect(skippedEvents).toEqual([
      {
        stage: "worktree_init_complete",
        payload: expect.objectContaining({
          success: true,
          stepsRun: 0,
          errorCount: 0,
          phase: "post_worker_refresh",
        }),
      },
    ]);
  });

  test("post-worker refresh leaves the restored dependency tree untouched when staging fails", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "original");
    setMockExecFailure(17, "staged install failed");

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatchObject({ exitCode: 17 });
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "original",
    );
    expect((await fs.readdir(tmpDir)).filter((entry) => entry.startsWith(".quack-"))).toEqual([]);
  });

  test("post-worker refresh atomically replaces the trusted tree after staging succeeds", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "1.0.0" } }),
    );
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "original");
    _setWorktreeInitCommandRunner(async (input) => {
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      await fs.writeFile(path.join(input.cwd, "node_modules", "fresh.txt"), "installed");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(true);
    await expect(fs.readFile(path.join(trustedModules, "fresh.txt"), "utf8")).resolves.toBe(
      "installed",
    );
    await expect(fs.access(path.join(trustedModules, "trusted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.readdir(tmpDir)).filter((entry) => entry.startsWith(".quack-"))).toEqual([]);
  });

  test("post-worker refresh never publishes a partial transaction journal", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "original");
    let publications = 0;
    _setWorktreeInitAtomicFilePublisher(async (pendingPath, finalPath) => {
      publications += 1;
      const pending = JSON.parse(await fs.readFile(pendingPath, "utf8")) as {
        version?: number;
        items?: unknown[];
      };
      expect(pending.version).toBe(1);
      expect(pending.items).toHaveLength(1);
      await expect(fs.access(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
      throw new Error("simulated publication interruption");
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("simulated publication interruption");
    expect(publications).toBe(1);
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "original",
    );
    await expect(fs.access(await dependencyRefreshLockPath(tmpDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("post-worker refresh stages every package before replacing any dependency tree", async () => {
    const frontend = path.join(tmpDir, "frontend");
    await fs.mkdir(frontend);
    for (const directory of [tmpDir, frontend]) {
      await fs.writeFile(path.join(directory, "package.json"), "{}");
      await fs.writeFile(path.join(directory, "package-lock.json"), "{}");
      await fs.mkdir(path.join(directory, "node_modules"));
      await fs.writeFile(path.join(directory, "node_modules", "trusted.txt"), directory);
    }
    let calls = 0;
    _setWorktreeInitCommandRunner(async (input) => {
      calls += 1;
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      await fs.writeFile(path.join(input.cwd, "node_modules", "fresh.txt"), "installed");
      return {
        exitCode: calls === 2 ? 23 : 0,
        stdout: "",
        stderr: calls === 2 ? "second package failed" : "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, [
      "package.json",
      "frontend/package.json",
    ]);

    expect(result.success).toBe(false);
    expect(calls).toBe(2);
    for (const directory of [tmpDir, frontend]) {
      await expect(
        fs.readFile(path.join(directory, "node_modules", "trusted.txt"), "utf8"),
      ).resolves.toBe(directory);
      await expect(
        fs.access(path.join(directory, "node_modules", "fresh.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(directory)).filter((entry) => entry.startsWith(".quack-"))).toEqual(
        [],
      );
    }
  });

  test("post-worker refresh emits only the final failed completion when staged output is missing", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "1.0.0" } }),
    );
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const events = {
      emit: (stage: string, payload: unknown) => emitted.push({ stage, payload }),
    } as unknown as IEventWriter;

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"], events);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("produced no node_modules");
    const completions = emitted.filter((event) => event.stage === "worktree_init_complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({
      success: false,
      phase: "post_worker_refresh",
    });
  });

  test("post-worker refresh rejects empty staged output for a dependency-bearing package", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "1.0.0" } }),
    );
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "original");
    _setWorktreeInitCommandRunner(async (input) => {
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("empty node_modules");
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "original",
    );
  });

  test("post-worker refresh rolls back and emits one final failure when npm cleanup fails", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "original");
    _setWorktreeInitCommandRunner(async (input) => {
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      await fs.writeFile(path.join(input.cwd, "node_modules", "fresh.txt"), "fresh");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });
    _setWorktreeInitEnvironmentCleanup(async (cleanupRoot) => {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      throw new Error("simulated cleanup refusal");
    });
    const emitted: Array<{ stage: string; payload: unknown }> = [];
    const events = {
      emit: (stage: string, payload: unknown) => emitted.push({ stage, payload }),
    } as unknown as IEventWriter;

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"], events);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toEqual({
      step: "temporary npm environment cleanup",
      message: "simulated cleanup refusal",
    });
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "original",
    );
    await expect(fs.access(path.join(trustedModules, "fresh.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const completions = emitted.filter((event) => event.stage === "worktree_init_complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({
      success: false,
      errorCount: 1,
      phase: "post_worker_refresh",
    });
  });

  test("post-worker refresh serializes concurrent refreshes for one worktree", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    let releaseFirst!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    _setWorktreeInitCommandRunner(async (input) => {
      signalStarted();
      await release;
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });

    const first = runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);
    await started;
    const concurrent = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);
    releaseFirst();
    const completed = await first;

    expect(concurrent.success).toBe(false);
    expect(concurrent.errors[0]?.message).toContain("Another dependency refresh is active");
    expect(completed.success).toBe(true);
  });

  test("post-worker refresh rolls back an abandoned uncommitted transaction", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "new.txt"), "new");
    await fs.mkdir(backupNodeModules);
    await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
    await fs.mkdir(stagingDirectory);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const canonicalRoot = await fs.realpath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: false,
          },
        ],
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.readFile(path.join(targetNodeModules, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.access(path.join(targetNodeModules, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh restores and recovers a legacy orphaned recovery barrier", async () => {
    const transactionId = "66666666-6666-4666-8666-666666666666";
    const canonicalLock = await dependencyRefreshLockPath(tmpDir);
    const legacyRecovery = `${canonicalLock}.recovery-77777777-7777-4777-8777-777777777777`;
    const canonicalRoot = await fs.realpath(tmpDir);
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "new.txt"), "new");
    await fs.mkdir(backupNodeModules);
    await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
    await fs.mkdir(stagingDirectory);
    await fs.mkdir(legacyRecovery, { recursive: true });
    await writeLegacyAbandonedOwner(legacyRecovery, canonicalRoot);
    await fs.writeFile(
      path.join(legacyRecovery, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: false,
          },
        ],
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.readFile(path.join(targetNodeModules, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.access(legacyRecovery)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(canonicalLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh finalizes an abandoned committed transaction", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const transactionId = "22222222-2222-4222-8222-222222222222";
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "new.txt"), "new");
    await fs.mkdir(backupNodeModules);
    await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
    await fs.mkdir(stagingDirectory);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const canonicalRoot = await fs.realpath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(path.join(lockDirectory, "COMMITTED"), `${transactionId}\n`);
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: false,
          },
        ],
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.readFile(path.join(targetNodeModules, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.access(backupNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh preserves the canonical barrier across repeated recovery failures", async () => {
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-init-backup-alias-"));
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "new.txt"), "new");
    await fs.mkdir(stagingDirectory);
    await fs.symlink(outside, backupNodeModules, process.platform === "win32" ? "junction" : "dir");
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const canonicalRoot = await fs.realpath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: false,
          },
        ],
      }),
    );

    try {
      const first = await runPostWorkerDependencyRefresh(tmpDir, []);
      const second = await runPostWorkerDependencyRefresh(tmpDir, []);

      expect(first.success).toBe(false);
      expect(second.success).toBe(false);
      expect(first.errors[0]?.message).toContain("dependency backup must be a physical directory");
      await expect(fs.access(lockDirectory)).resolves.toBeUndefined();
      await expect(fs.readFile(path.join(targetNodeModules, "new.txt"), "utf8")).resolves.toBe(
        "new",
      );

      await fs.unlink(backupNodeModules);
      await fs.mkdir(backupNodeModules);
      await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
      const recovered = await runPostWorkerDependencyRefresh(tmpDir, []);

      expect(recovered).toEqual({ success: true, stepsRun: 0, errors: [] });
      await expect(fs.readFile(path.join(targetNodeModules, "old.txt"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("post-worker recovery requires a transaction-bound physical commit marker", async () => {
    const transactionId = "44444444-4444-4444-8444-444444444444";
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "new.txt"), "new");
    await fs.mkdir(backupNodeModules);
    await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
    await fs.mkdir(stagingDirectory);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const canonicalRoot = await fs.realpath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(path.join(lockDirectory, "COMMITTED"), "wrong-transaction\n");
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: false,
          },
        ],
      }),
    );

    const mismatched = await runPostWorkerDependencyRefresh(tmpDir, []);
    expect(mismatched.success).toBe(false);
    expect(mismatched.errors[0]?.message).toContain("does not match its transaction");
    await expect(fs.access(backupNodeModules)).resolves.toBeUndefined();
    await expect(fs.access(lockDirectory)).resolves.toBeUndefined();

    await fs.rm(path.join(lockDirectory, "COMMITTED"));
    await fs.mkdir(path.join(lockDirectory, "COMMITTED"));
    const nonPhysical = await runPostWorkerDependencyRefresh(tmpDir, []);
    expect(nonPhysical.success).toBe(false);
    expect(nonPhysical.errors[0]?.message).toContain("must be a small physical file");
    await expect(fs.access(backupNodeModules)).resolves.toBeUndefined();

    await fs.rm(path.join(lockDirectory, "COMMITTED"), { recursive: true });
    await fs.writeFile(path.join(lockDirectory, "COMMITTED"), `${transactionId}\n`);
    const recovered = await runPostWorkerDependencyRefresh(tmpDir, []);
    expect(recovered).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.readFile(path.join(targetNodeModules, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.access(backupNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("committed recovery refuses a non-directory dependency target without deleting backup", async () => {
    const transactionId = "55555555-5555-4555-8555-555555555555";
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const backupNodeModules = path.join(tmpDir, `.quack-node-modules-backup-${transactionId}-0`);
    const stagingDirectory = path.join(tmpDir, `.quack-dependency-refresh-${transactionId}-0`);
    await fs.writeFile(targetNodeModules, "not a directory");
    await fs.mkdir(backupNodeModules);
    await fs.writeFile(path.join(backupNodeModules, "old.txt"), "old");
    await fs.mkdir(stagingDirectory);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const canonicalRoot = await fs.realpath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(path.join(lockDirectory, "COMMITTED"), `${transactionId}\n`);
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [
          {
            cwd: ".",
            packageDirectory: canonicalRoot,
            stagingDirectory,
            stagedNodeModules: path.join(stagingDirectory, "node_modules"),
            targetNodeModules,
            backupNodeModules,
            hadTarget: true,
            requiresNodeModules: true,
          },
        ],
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain(
      "committed dependencies must be a physical directory",
    );
    await expect(fs.readFile(path.join(backupNodeModules, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.access(lockDirectory)).resolves.toBeUndefined();
  });

  test("post-worker refresh transactionally removes dependencies for a deleted package manifest", async () => {
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "obsolete.txt"), "old");
    let calls = 0;
    _setWorktreeInitCommandRunner(async () => {
      calls += 1;
      throw new Error("npm must not run for a deleted package");
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, [
      "package.json",
      "package-lock.json",
    ]);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    expect(calls).toBe(0);
    await expect(fs.access(trustedModules)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh fails closed when lock metadata remains without package.json", async () => {
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "old");

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("lock metadata without package.json");
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "old",
    );
  });

  test("post-worker refresh falls back to npm install when a lockfile was deleted", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const commands: string[] = [];
    mockExecImpl = async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "" };
    };

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package-lock.json"]);

    expect(result.success).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/npm-cli\.js install --ignore-scripts --no-audit --no-fund$/);
  });

  test("post-worker refresh rolls back every deleted package when a later rename fails", async () => {
    const child = path.join(tmpDir, "child");
    await fs.mkdir(child);
    for (const [directory, marker] of [
      [tmpDir, "root"],
      [child, "child"],
    ] as const) {
      await fs.mkdir(path.join(directory, "node_modules"));
      await fs.writeFile(path.join(directory, "node_modules", "trusted.txt"), marker);
    }
    let renames = 0;
    _setWorktreeInitDependencyRefreshRename(async (source, destination) => {
      renames += 1;
      if (renames === 2) throw new Error("simulated package rename interruption");
      await fs.rename(source, destination);
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, [
      "package.json",
      "child/package.json",
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("simulated package rename interruption");
    await expect(
      fs.readFile(path.join(tmpDir, "node_modules", "trusted.txt"), "utf8"),
    ).resolves.toBe("root");
    await expect(
      fs.readFile(path.join(child, "node_modules", "trusted.txt"), "utf8"),
    ).resolves.toBe("child");
  });

  test("post-worker refresh rolls back a deleted package when commit publication fails", async () => {
    const trustedModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(trustedModules);
    await fs.writeFile(path.join(trustedModules, "trusted.txt"), "old");
    let publications = 0;
    _setWorktreeInitAtomicFilePublisher(async (pendingPath, finalPath) => {
      publications += 1;
      if (path.basename(finalPath) === "COMMITTED") {
        throw new Error("simulated commit publication interruption");
      }
      await fs.link(pendingPath, finalPath);
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("simulated commit publication interruption");
    expect(publications).toBe(2);
    await expect(fs.readFile(path.join(trustedModules, "trusted.txt"), "utf8")).resolves.toBe(
      "old",
    );
  });

  test("post-worker refresh flushes package-directory renames before publishing COMMITTED", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "1.0.0" } }),
    );
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    await fs.mkdir(path.join(tmpDir, "node_modules"));
    await fs.writeFile(path.join(tmpDir, "node_modules", "old.txt"), "old");
    _setWorktreeInitCommandRunner(async (input) => {
      await fs.mkdir(path.join(input.cwd, "node_modules"));
      await fs.writeFile(path.join(input.cwd, "node_modules", "fresh.txt"), "fresh");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });
    const order: string[] = [];
    const canonicalRoot = await fs.realpath(tmpDir);
    _setWorktreeInitDependencyRefreshDirectorySync(async (directory) => {
      order.push(`sync:${directory}`);
    });
    _setWorktreeInitAtomicFilePublisher(async (pendingPath, finalPath) => {
      order.push(`publish:${path.basename(finalPath)}`);
      await fs.link(pendingPath, finalPath);
    });

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(true);
    const packageSync = order.indexOf(`sync:${canonicalRoot}`);
    const commitPublication = order.indexOf("publish:COMMITTED");
    expect(packageSync).toBeGreaterThan(-1);
    expect(commitPublication).toBeGreaterThan(packageSync);
  });

  test("post-worker recovery rejects overlapping journal mutation paths without deleting them", async () => {
    const transactionId = "77777777-7777-4777-8777-777777777777";
    const canonicalRoot = await fs.realpath(tmpDir);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const targetNodeModules = path.join(tmpDir, "node_modules");
    await fs.mkdir(targetNodeModules);
    await fs.writeFile(path.join(targetNodeModules, "trusted.txt"), "old");
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.writeFile(
      path.join(lockDirectory, "transaction.json"),
      JSON.stringify({
        version: 1,
        transactionId,
        canonicalRoot,
        items: [0, 1].map((index) => ({
          cwd: ".",
          packageDirectory: canonicalRoot,
          stagingDirectory: path.join(
            canonicalRoot,
            `.quack-dependency-refresh-${transactionId}-${index}`,
          ),
          stagedNodeModules: path.join(
            canonicalRoot,
            `.quack-dependency-refresh-${transactionId}-${index}`,
            "node_modules",
          ),
          targetNodeModules,
          backupNodeModules: path.join(
            canonicalRoot,
            `.quack-node-modules-backup-${transactionId}-${index}`,
          ),
          hadTarget: true,
          requiresNodeModules: false,
        })),
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("transaction paths overlap");
    await expect(fs.readFile(path.join(targetNodeModules, "trusted.txt"), "utf8")).resolves.toBe(
      "old",
    );
    await expect(fs.access(lockDirectory)).resolves.toBeUndefined();
  });

  test("post-worker refresh requires an owner-bound physical abandonment record", async () => {
    const canonicalRoot = await fs.realpath(tmpDir);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const now = Date.now();
    const owner = {
      version: 2,
      pid: process.pid,
      processNonce: "88888888-8888-4888-8888-888888888888",
      operationNonce: "99999999-9999-4999-8999-999999999999",
      canonicalRoot,
      createdAtMs: now,
      leaseExpiresAtMs: now + 60_000,
    };
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify(owner));
    await fs.writeFile(
      path.join(lockDirectory, "ABANDONED"),
      JSON.stringify({
        version: 1,
        canonicalRoot,
        processNonce: owner.processNonce,
        operationNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        abandonedAtMs: now,
      }),
    );

    const mismatched = await runPostWorkerDependencyRefresh(tmpDir, []);
    expect(mismatched.success).toBe(false);
    expect(mismatched.errors[0]?.message).toContain("does not match its owner");
    await expect(fs.access(lockDirectory)).resolves.toBeUndefined();

    await fs.writeFile(
      path.join(lockDirectory, "ABANDONED"),
      JSON.stringify({
        version: 1,
        canonicalRoot,
        processNonce: owner.processNonce,
        operationNonce: owner.operationNonce,
        abandonedAtMs: now,
      }),
    );
    const recovered = await runPostWorkerDependencyRefresh(tmpDir, []);
    expect(recovered).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh recognizes same-PID reuse before an unexpired lease", async () => {
    const canonicalRoot = await fs.realpath(tmpDir);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const now = Date.now();
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      path.join(lockDirectory, "owner.json"),
      JSON.stringify({
        version: 2,
        pid: process.pid,
        processNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        operationNonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        canonicalRoot,
        createdAtMs: now,
        leaseExpiresAtMs: now + 60_000,
      }),
    );

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("legacy abandonment cannot bypass a live foreign owner", async () => {
    const canonicalRoot = await fs.realpath(tmpDir);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    await fs.mkdir(lockDirectory, { recursive: true });
    await fs.writeFile(
      path.join(lockDirectory, "owner.json"),
      JSON.stringify({ version: 1, pid: process.ppid, canonicalRoot }),
    );
    await fs.writeFile(path.join(lockDirectory, "ABANDONED"), "recovery required\n");

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("cannot bypass a live owner");
    await expect(fs.access(lockDirectory)).resolves.toBeUndefined();
  });

  test("post-worker refresh can replace an inactive same-process recovery claim", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    let processNonce: string | undefined;
    _setWorktreeInitAtomicFilePublisher(async (pendingPath, finalPath) => {
      const owner = JSON.parse(
        await fs.readFile(path.join(path.dirname(finalPath), "owner.json"), "utf8"),
      ) as { processNonce?: string };
      processNonce = owner.processNonce;
      await fs.link(pendingPath, finalPath);
    });
    const initial = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);
    expect(initial.success).toBe(true);
    expect(processNonce).toMatch(/^[0-9a-f-]{36}$/iu);
    if (!processNonce) throw new Error("dependency refresh process nonce was not captured");
    _setWorktreeInitAtomicFilePublisher(undefined);

    const canonicalRoot = await fs.realpath(tmpDir);
    const claimDirectory = `${lockDirectory}.recovery-claim`;
    const now = Date.now();
    await fs.mkdir(lockDirectory, { recursive: true });
    await writeLegacyAbandonedOwner(lockDirectory, canonicalRoot);
    await fs.mkdir(claimDirectory);
    await fs.writeFile(
      path.join(claimDirectory, "owner.json"),
      JSON.stringify({
        version: 2,
        pid: process.pid,
        processNonce,
        operationNonce: "12121212-1212-4212-8212-121212121212",
        canonicalRoot,
        createdAtMs: now,
        leaseExpiresAtMs: now + 60_000,
      }),
    );

    const recovered = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(recovered).toEqual({ success: true, stepsRun: 0, errors: [] });
    await expect(fs.access(claimDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("post-worker refresh scavenges only stale same-project artifacts", async () => {
    const canonicalRoot = await fs.realpath(tmpDir);
    const lockDirectory = await dependencyRefreshLockPath(tmpDir);
    const runtimeRoot = path.dirname(lockDirectory);
    const key = path.basename(lockDirectory);
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const fresh = Date.now();
    await fs.mkdir(runtimeRoot, { recursive: true });
    const artifacts = [
      {
        path: path.join(runtimeRoot, `${key}.candidate-staleone`),
        root: canonicalRoot,
        createdAtMs: old,
        leaseExpiresAtMs: old + 60_000,
        shouldRemain: false,
      },
      {
        path: path.join(runtimeRoot, `${key}.recovery-claim.candidate-staletwo`),
        root: canonicalRoot,
        createdAtMs: old,
        leaseExpiresAtMs: old + 60_000,
        shouldRemain: false,
      },
      {
        path: path.join(
          runtimeRoot,
          `${key}.recovery-claim.stale-dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
        ),
        root: canonicalRoot,
        createdAtMs: old,
        leaseExpiresAtMs: old + 60_000,
        shouldRemain: false,
      },
      {
        path: path.join(runtimeRoot, `${key}.candidate-freshone`),
        root: canonicalRoot,
        createdAtMs: fresh,
        leaseExpiresAtMs: fresh + 60_000,
        shouldRemain: true,
      },
      {
        path: path.join(runtimeRoot, `${key}.candidate-wrongroot`),
        root: `${canonicalRoot}-other`,
        createdAtMs: old,
        leaseExpiresAtMs: old + 60_000,
        shouldRemain: true,
      },
    ];
    for (const [index, artifact] of artifacts.entries()) {
      await fs.mkdir(artifact.path);
      await fs.writeFile(
        path.join(artifact.path, "owner.json"),
        JSON.stringify({
          version: 2,
          pid: process.pid,
          processNonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          operationNonce: `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, "0")}`,
          canonicalRoot: artifact.root,
          createdAtMs: artifact.createdAtMs,
          leaseExpiresAtMs: artifact.leaseExpiresAtMs,
        }),
      );
      const touched = new Date(artifact.createdAtMs);
      await fs.utimes(artifact.path, touched, touched);
    }

    const result = await runPostWorkerDependencyRefresh(tmpDir, []);

    expect(result.success).toBe(true);
    for (const artifact of artifacts) {
      if (artifact.shouldRemain) {
        await expect(fs.access(artifact.path)).resolves.toBeUndefined();
      } else {
        await expect(fs.access(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  test("post-worker refresh rejects a project npmrc before invoking npm", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");
    await fs.writeFile(
      path.join(tmpDir, ".npmrc"),
      `cache=${path.join(tmpDir, "..", "outside-cache")}`,
    );
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    };
    _setWorktreeInitCommandRunner(runner);

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("Project .npmrc is not allowed");
    expect(calls).toBe(0);
  });

  test("post-worker refresh removes earlier staging when a later package fails preflight", async () => {
    const frontend = path.join(tmpDir, "frontend");
    await fs.mkdir(frontend);
    for (const directory of [tmpDir, frontend]) {
      await fs.writeFile(path.join(directory, "package.json"), "{}");
      await fs.writeFile(path.join(directory, "package-lock.json"), "{}");
    }
    await fs.writeFile(path.join(frontend, ".npmrc"), "registry=https://attacker.invalid/");

    const result = await runPostWorkerDependencyRefresh(tmpDir, [
      "package.json",
      "frontend/package.json",
    ]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("Project .npmrc is not allowed");
    expect((await fs.readdir(tmpDir)).filter((entry) => entry.startsWith(".quack-"))).toEqual([]);
  });

  test("post-worker refresh rejects non-registry lockfile URLs", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "1.0.0" } }),
    );
    await fs.writeFile(
      path.join(tmpDir, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/demo": { resolved: "https://internal.invalid/demo.tgz" } },
      }),
    );
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    };
    _setWorktreeInitCommandRunner(runner);

    const result = await runPostWorkerDependencyRefresh(tmpDir, ["package-lock.json"]);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.message).toContain("non-public-registry URL");
    expect(calls).toBe(0);
  });

  test("post-worker refresh rejects dependency URLs and workspace traversal", async () => {
    let calls = 0;
    _setWorktreeInitCommandRunner(async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      };
    });
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { demo: "file:C:\\outside" } }),
    );

    const unsafeDependency = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(unsafeDependency.success).toBe(false);
    expect(unsafeDependency.errors[0]?.message).toContain("Unsafe dependencies spec");

    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["../outside"] }),
    );
    const unsafeWorkspace = await runPostWorkerDependencyRefresh(tmpDir, ["package.json"]);

    expect(unsafeWorkspace.success).toBe(false);
    expect(unsafeWorkspace.errors[0]?.message).toContain("workspaces are not allowed");
    expect(calls).toBe(0);
  });
});
