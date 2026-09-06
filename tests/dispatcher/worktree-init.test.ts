// ─── Worktree Init Tests ────────────────────────────────────────────

/* eslint-disable @typescript-eslint/require-await */
// Mock implementations are typed `Promise<ExecMockResult>`, so they're declared
// `async` for return-type inference even when the body is a single literal.

import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

// ── Mock child_process BEFORE importing the module under test ──────────
// Uses the promisify.custom symbol so that promisify(exec) picks up our mock.
// This is the established pattern in this codebase (see branch-manager.test.ts).

type ExecMockResult = { stdout: string; stderr: string };

// Module-level mutable function — each test reassigns this to control behavior
let mockExecImpl: (command: string, options: unknown) => Promise<ExecMockResult> = async () => ({
  stdout: "",
  stderr: "",
});

jest.mock("node:child_process", () => {
  const customPromisified = (command: string, options: unknown): Promise<ExecMockResult> =>
    mockExecImpl(command, options);

  const mockExec = jest.fn();
  (mockExec as unknown as Record<symbol, unknown>)[promisify.custom] = customPromisified;

  return { exec: mockExec };
});

// Import AFTER jest.mock() is hoisted
import { runWorktreeInit } from "../../src/dispatcher/worktree-init.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";

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

describe("worktree-init", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-init-test-"));
    setMockExecSuccess();
  });

  afterEach(async () => {
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
    expect(calledCommands[0]).toBe("npm ci");
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
    expect(calledCommands[0]).toBe("npm install");
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
});
