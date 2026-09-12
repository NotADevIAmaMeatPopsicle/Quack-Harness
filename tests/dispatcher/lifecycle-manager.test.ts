import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type {
  AgentOutputSnapshot,
  AgentResult,
  ParsedTask,
  TaskContext,
} from "../../src/core/types.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";
import type { RunAgentOptions } from "../../src/worker/agent-worker.js";

// ─── Mocks ─────────────────────────────────────────────────────────

jest.mock("node:child_process", () => ({
  execSync: jest.fn().mockReturnValue("abc1234"),
}));

const mockRunTrustedGitSync = jest.fn().mockReturnValue("abc1234");
jest.mock("../../src/dispatcher/trusted-git", () => ({
  runTrustedGitSync: (...args: unknown[]) => mockRunTrustedGitSync(...args),
}));

jest.mock("node:fs", () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    appendFile: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    readdir: jest.fn().mockImplementation(() => Promise.resolve([])),
    mkdir: jest.fn(),
    access: jest.fn(),
  },
  existsSync: jest.fn().mockReturnValue(true),
}));

// TASK-1334 (S1-R2): isolate this suite at the RESOLVER seam, not the
// filesystem seam.
//
// `findTaskFile` now resolves through `task-file-resolver`, which does its own
// directory reads through `node:fs/promises` (a different specifier from the
// `node:fs` mocked above) and needs real file contents to parse. This suite
// never modelled a task DIRECTORY: its `access` mock resolves for ANY path, so
// the old exact-path probe returned `${taskId}.md` immediately and `readdir`
// defaulting to `[]` never mattered.
//
// These tests are about lifecycle ORCHESTRATION, not about which file is the
// task, so the honest fix is to stub the selection and keep the orchestration
// assertions exactly as they were. The stub reproduces the old exact-path
// behaviour, so every existing expectation still means what it meant.
//
// File SELECTION is proved separately, against a real temp directory, in
// `tests/dispatcher/lifecycle-task-selection.test.ts`. Mocking it here would
// otherwise be the false-green this task exists to remove, which is why that
// companion suite is not optional.
const mockResolveTaskFile = jest.fn(async (taskDir: string, taskId: string) => {
  const filePath = [taskDir, `${taskId}.md`].join("/");
  // Round 2 (R2-1): production now CARRIES the resolver's content instead
  // of re-reading, so this stub hands back whatever the suite's `node:fs`
  // mock holds for the same path; an empty string here would blank every
  // status arm's input. Importing inside the stub goes through jest's
  // module registry, so this IS the mocked module, with real typings.
  const { promises: mockedPromises } = await import("node:fs");
  let content = "";
  try {
    const raw: unknown = await mockedPromises.readFile(filePath, "utf-8");
    content = typeof raw === "string" ? raw : "";
  } catch {
    content = "";
  }
  return { fileName: `${taskId}.md`, filePath, content, task: null };
});
jest.mock("../../src/core/task-file-resolver", () => ({
  // This orchestration fixture has no parsed directory; exercise its existing
  // exact-path fallback. Real declaration lookup is proved by the disk suites.
  listTaskClaimantDeclarations: jest.fn(() => Promise.resolve([])),
  listDuplicateClaimants: jest.fn(() => Promise.resolve([])),
  resolveTaskFile: (...args: [string, string]) => mockResolveTaskFile(...args),
}));

jest.mock("../../src/core/task-parser", () => ({
  parseTaskFile: jest.fn(),
}));

const mockWithCanonicalTaskSpecMutationFence = jest.fn(
  async (input: {
    taskFilePath: string;
    replacementContent: string;
    afterWrite?: () => unknown;
  }) => {
    const { promises: mockedPromises } = await import("node:fs");
    await mockedPromises.writeFile(input.taskFilePath, input.replacementContent, "utf-8");
    return input.afterWrite?.();
  },
);
class MockCanonicalTaskSpecMutationError extends Error {
  claimants: string[] = [];
}
jest.mock("../../src/preflight/canonical-task-spec-mutation", () => ({
  CanonicalTaskSpecMutationError: MockCanonicalTaskSpecMutationError,
  withCanonicalTaskSpecMutationFence: (input: {
    taskFilePath: string;
    replacementContent: string;
    afterWrite?: () => unknown;
  }) => mockWithCanonicalTaskSpecMutationFence(input),
}));

const mockRunAgent =
  jest.fn<
    (
      taskId: string,
      context: TaskContext,
      adapter: ProjectAdapter,
      options?: RunAgentOptions,
      events?: IEventWriter,
    ) => Promise<AgentResult>
  >();
jest.mock("../../src/worker/agent-worker", () => ({
  runAgent: (...args: [string, TaskContext, ProjectAdapter, RunAgentOptions?, IEventWriter?]) =>
    mockRunAgent(...args),
}));

const mockSealAgentOutputAttempt =
  jest.fn<(input: Record<string, unknown>) => Promise<AgentOutputSnapshot>>();
jest.mock("../../src/dispatcher/output-snapshot", () => ({
  sealAgentOutputAttempt: (input: Record<string, unknown>) => mockSealAgentOutputAttempt(input),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────

import {
  runPostApprovalLifecycle,
  updateTaskStatus,
  _setQueryFn,
} from "../../src/dispatcher/lifecycle-manager.js";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { parseTaskFile } from "../../src/core/task-parser.js";

// ─── Helpers ───────────────────────────────────────────────────────

const mockExecSync = execSync as ReturnType<typeof jest.fn>;
const mockReadFile = fs.readFile as ReturnType<typeof jest.fn>;
const mockWriteFile = fs.writeFile as ReturnType<typeof jest.fn>;
const mockAppendFile = fs.appendFile as ReturnType<typeof jest.fn>;
const mockReaddir = fs.readdir as ReturnType<typeof jest.fn>;
const mockAccess = fs.access as ReturnType<typeof jest.fn>;
const mockParseTaskFile = parseTaskFile as ReturnType<typeof jest.fn>;

let tmpDir: string;

function makeAdapter(overrides?: Partial<ProjectAdapter>): ProjectAdapter {
  return {
    projectRoot: tmpDir,
    config: {
      project: { name: "test", root: ".", taskDir: "docs/tasks", conventionsDir: ".quack" },
      agent: {
        model: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        maxRetries: 1,
        maxTurns: 75,
        maxBudgetPerTask: 5,
      },
      verification: { commands: [], conventionChecks: [] },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
      },
      logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
      sandbox: {
        writablePaths: [],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      revision: { maxBudget: 2.0, maxTurns: 30 },
    },
    conventionsDoc: "",
    judgeCriteria: "",
    ...overrides,
  } as unknown as ProjectAdapter;
}

function makeTask(overrides?: Partial<ParsedTask>): ParsedTask {
  return {
    id: "TASK-100",
    title: "Test Task",
    priority: "P2-MEDIUM",
    effort: "M",
    status: "READY",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: ["Criterion 1", "Criterion 2"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-100: Test Task\n## Metadata\n- **Status:** READY\n",
    ...overrides,
  } as ParsedTask;
}

function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    taskId: "TASK-100",
    outcome: "success",
    filesModified: ["src/game.ts"],
    filesCreated: [],
    verification: {
      allPassed: true,
      commands: [],
      conventionChecks: [],
    },
    turnsUsed: 1,
    totalCostUsd: 0,
    messages: [],
    claudeSessionId: "codex-thread-1",
    ...overrides,
  };
}

function makeEvents(): IEventWriter {
  return {
    sessionId: "test-session",
    taskId: "TASK-100",
    project: "test",
    emit: jest.fn(),
    recordSession: jest.fn(),
  } as unknown as IEventWriter;
}

/**
 * Build a mock query function that returns the given text from the SDK stream.
 */
function makeMockQueryFn(responseText: string) {
  // eslint-disable-next-line @typescript-eslint/require-await
  return jest.fn().mockImplementation(async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: responseText,
    };
  });
}

/**
 * Build an adversarial-verification response where all criteria PASS.
 */
function allPassResponse(criteria: string[]): string {
  const lines: string[] = [];
  for (const c of criteria) {
    lines.push(`CRITERION: ${c}`);
    lines.push("STATUS: PASS");
    lines.push(`EVIDENCE: Verified in source code`);
    lines.push("");
  }
  lines.push("OVERALL: PASS");
  return lines.join("\n");
}

/**
 * Build an adversarial-verification response where specific criteria FAIL.
 */
function mixedResponse(criteria: string[], failIndices: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < criteria.length; i++) {
    lines.push(`CRITERION: ${criteria[i]}`);
    if (failIndices.includes(i)) {
      lines.push("STATUS: FAIL");
      lines.push(`EVIDENCE: Not implemented correctly`);
    } else {
      lines.push("STATUS: PASS");
      lines.push(`EVIDENCE: Verified in source code`);
    }
    lines.push("");
  }
  const hasFail = failIndices.length > 0;
  lines.push(`OVERALL: ${hasFail ? "FAIL" : "PASS"}`);
  return lines.join("\n");
}

// ─── Task file content helper ──────────────────────────────────────

function taskFileContent(
  id: string,
  status: string,
  extra?: { blocks?: string[]; blockedBy?: string[]; parent?: string },
): string {
  const blocks = extra?.blocks ?? [];
  const blockedBy = extra?.blockedBy ?? [];
  const parentLine = extra?.parent ? `\nParent Task: ${extra.parent}` : "";
  return `# ${id}: Test Task
## Metadata
- **Priority:** P2-MEDIUM
- **Status:** ${status}
- **Blocked By:** [${blockedBy.join(", ")}]
- **Blocks:** [${blocks.join(", ")}]
${parentLine}
## Success Criteria
- [ ] Criterion 1
`;
}

// ─── Test Suite ────────────────────────────────────────────────────

describe("runPostApprovalLifecycle", () => {
  let adapter: ProjectAdapter;
  let events: IEventWriter;

  /**
   * Tracks content written by writeFile so that subsequent readFile calls
   * return the updated content (needed because updateTaskStatus does a
   * post-write re-read to verify the status was written correctly).
   */
  const writtenFiles = new Map<string, string>();

  beforeEach(() => {
    jest.clearAllMocks();
    writtenFiles.clear();
    tmpDir = "/tmp/lifecycle-test";
    adapter = makeAdapter();
    events = makeEvents();

    // Default: execSync returns a commit SHA
    mockExecSync.mockReturnValue("abc1234");

    // Default: readdir returns empty (no task files)
    mockReaddir.mockResolvedValue([]);

    // Default: access succeeds (file exists)
    mockAccess.mockResolvedValue(undefined);

    // Default: readFile returns empty string
    mockReadFile.mockResolvedValue("");

    // Default: writeFile succeeds and tracks written content
    mockWriteFile.mockImplementation((filePath: string, content: string) => {
      writtenFiles.set(filePath, content);
      return Promise.resolve(undefined);
    });
    mockAppendFile.mockResolvedValue(undefined);
    mockRunAgent.mockReset();
    mockRunAgent.mockResolvedValue(makeAgentResult());
    mockSealAgentOutputAttempt.mockResolvedValue({} as AgentOutputSnapshot);
  });

  afterEach(() => {
    _setQueryFn(undefined as unknown as Parameters<typeof _setQueryFn>[0]);
  });

  // ── Test 1: Adversarial verification passes, full lifecycle completes ─

  test("adversarial verification passes, full lifecycle completes", async () => {
    const task = makeTask();
    const response = allPassResponse(task.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // readFile: return written content if available, otherwise original
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.statusUpdated).toBe(true);
    expect(result.fixAttemptsUsed).toBe(0);
    expect(result.verificationFindings.length).toBeGreaterThan(0);
    expect(result.verificationFindings.every((f) => f.status === "pass")).toBe(true);
  });

  // ── Test 2: Adversarial verification finds issues, fix cycle succeeds ─

  test("Claude lifecycle repair uses the guarded worker, deterministic verification, and sealing", async () => {
    const task = makeTask();
    let callCount = 0;

    // First call: verify fails (2 failures)
    // Second call: post-seal verification passes. The repair itself must run
    // through runAgent, not a direct SDK query.
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQuery = jest.fn().mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // First adversarial verification — 2 failures
        yield {
          type: "result",
          subtype: "success",
          result: mixedResponse(task.successCriteria, [0, 1]),
        };
      } else {
        // Adversarial re-verification — all pass
        yield {
          type: "result",
          subtype: "success",
          result: allPassResponse(task.successCriteria),
        };
      }
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // readFile: return written content if available, otherwise original
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.fixAttemptsUsed).toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(2); // initial verify + post-seal re-verify
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const [, context, repairAdapter, options, workerEvents] = mockRunAgent.mock.calls[0];
    expect(context.taskSpecPath?.replace(/\\/g, "/")).toMatch(
      /\/tmp\/lifecycle-test\/docs\/tasks\/TASK-100\.md$/,
    );
    expect(context.blueprint).toContain("Do not run git write commands");
    expect(context.blueprint).not.toContain("commit them");
    expect(repairAdapter.projectRoot).toBe(tmpDir);
    expect(options).toEqual({
      model: "claude-sonnet-4-6",
      maxTurns: 30,
      maxBudgetUsd: 2,
    });
    expect(workerEvents).toBe(events);
    expect(mockSealAgentOutputAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "TASK-100",
        adapter: repairAdapter,
        events,
        attempt: 1,
        kind: "lifecycle_fix",
        claudeSessionId: "codex-thread-1",
      }),
    );
    expect(mockSealAgentOutputAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mockQuery.mock.invocationCallOrder[1],
    );
  });

  test("Codex lifecycle repair uses the mutable worker and seals its output", async () => {
    const task = makeTask({
      filesToModify: [
        {
          path: "src/game.ts",
          action: "Modify",
          notes: "repair behavior",
        },
      ],
      testingRequirements: ["npm test -- game"],
    });
    adapter = makeAdapter({
      projectRoot: "/configured/root-that-must-not-be-used",
      config: {
        ...adapter.config,
        agent: {
          ...adapter.config.agent,
          runner: "codex-cli",
          codex: {
            binaryPath: "codex",
            sandbox: "workspace-write",
            timeoutMs: 120_000,
          },
        },
      },
    });
    let verifyCall = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQuery = jest.fn().mockImplementation(async function* () {
      verifyCall += 1;
      yield {
        type: "result",
        subtype: "success",
        result:
          verifyCall === 1
            ? mixedResponse(task.successCriteria, [0])
            : allPassResponse(task.successCriteria),
      };
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent.mockResolvedValue(makeAgentResult());
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.fixAttemptsUsed).toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const [calledTaskId, context, repairAdapter, options, workerEvents] =
      mockRunAgent.mock.calls[0];
    expect(calledTaskId).toBe("TASK-100");
    expect(context).toMatchObject({
      taskSpec: expect.stringContaining("# TASK-100"),
      relevantFiles: ["src/game.ts"],
      existingTests: ["npm test -- game"],
    });
    expect(context.taskSpecPath?.replace(/\\/g, "/")).toMatch(
      /\/tmp\/lifecycle-test\/docs\/tasks\/TASK-100\.md$/,
    );
    expect(context.blueprint).toContain("Not implemented correctly");
    expect(context.blueprint).toContain("Do not run git write commands");
    expect(context.blueprint).not.toContain("commit them");
    expect(repairAdapter.projectRoot).toBe(tmpDir);
    expect(options).toEqual({
      model: "claude-sonnet-4-6",
      maxTurns: 30,
      maxBudgetUsd: 2,
    });
    expect(workerEvents).toBe(events);
    expect(mockSealAgentOutputAttempt).toHaveBeenCalledWith({
      taskId: "TASK-100",
      adapter: repairAdapter,
      events,
      attempt: 1,
      kind: "lifecycle_fix",
      claudeSessionId: "codex-thread-1",
    });
  });

  test("Codex lifecycle repair resumes the exact worker session", async () => {
    const task = makeTask();
    adapter.config.agent.runner = "codex-cli";
    let verifyCall = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQuery = jest.fn().mockImplementation(async function* () {
      verifyCall += 1;
      yield {
        type: "result",
        subtype: "success",
        result:
          verifyCall < 3
            ? mixedResponse(task.successCriteria, [verifyCall - 1])
            : allPassResponse(task.successCriteria),
      };
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent
      .mockResolvedValueOnce(makeAgentResult({ claudeSessionId: "codex-thread-1" }))
      .mockResolvedValueOnce(makeAgentResult({ claudeSessionId: "codex-thread-2" }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.fixAttemptsUsed).toBe(2);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent.mock.calls[0][3]).not.toHaveProperty("resumeSessionId");
    expect(mockRunAgent.mock.calls[1][3]).toMatchObject({
      resumeSessionId: "codex-thread-1",
    });
    expect(mockRunAgent.mock.calls[1][3]?.retryFeedback).toContain("Not implemented correctly");
    expect(mockSealAgentOutputAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attempt: 2,
        claudeSessionId: "codex-thread-2",
      }),
    );
  });

  test("Codex lifecycle repair contains invalid worker output and fails closed", async () => {
    const task = makeTask();
    adapter.config.agent.runner = "codex-cli";
    const mockQuery = makeMockQueryFn(mixedResponse(task.successCriteria, [0]));
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent
      .mockResolvedValueOnce(
        makeAgentResult({
          outcome: "failure",
          verification: null,
          error: "Codex --json emitted a malformed JSONL event",
          claudeSessionId: "codex-thread-1",
        }),
      )
      .mockResolvedValueOnce(
        makeAgentResult({
          outcome: "failure",
          verification: null,
          error: "Codex repair retry failed",
          claudeSessionId: "codex-thread-1",
        }),
      );
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result).toMatchObject({
      verified: false,
      statusUpdated: false,
      fixAttemptsUsed: 2,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockRunAgent.mock.calls[1][3]).toMatchObject({
      resumeSessionId: "codex-thread-1",
    });
    expect(mockSealAgentOutputAttempt).not.toHaveBeenCalled();
    const sessionErrors = (events.emit as ReturnType<typeof jest.fn>).mock.calls
      .filter((call: unknown[]) => call[0] === "session_error")
      .map((call: unknown[]) => call[1]);
    expect(sessionErrors).toContainEqual({
      error: expect.stringContaining("malformed JSONL"),
      failedStage: "lifecycle_fix",
      runner: "codex-cli",
      sessionId: "codex-thread-1",
    });
  });

  test("Claude lifecycle repair resumes its returned session and reports provider evidence", async () => {
    const task = makeTask();
    let verifyCall = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQuery = jest.fn().mockImplementation(async function* () {
      verifyCall += 1;
      yield {
        type: "result",
        subtype: "success",
        result:
          verifyCall < 3
            ? mixedResponse(task.successCriteria, [0])
            : allPassResponse(task.successCriteria),
      };
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent
      .mockResolvedValueOnce(makeAgentResult({ claudeSessionId: "claude-session-1" }))
      .mockResolvedValueOnce(makeAgentResult({ claudeSessionId: "claude-session-2" }));
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) return Promise.resolve(writtenFiles.get(filePath)!);
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result).toMatchObject({ verified: true, fixAttemptsUsed: 2 });
    expect(mockRunAgent.mock.calls[1][3]).toMatchObject({
      resumeSessionId: "claude-session-1",
      retryFeedback: expect.stringContaining("Not implemented correctly"),
    });
    expect(mockRunAgent.mock.calls[1][4]).toBe(events);
    const completions = (events.emit as ReturnType<typeof jest.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "lifecycle_fix_complete",
    );
    expect(completions).toEqual([
      [
        "lifecycle_fix_complete",
        expect.objectContaining({
          runner: "claude-sdk",
          sessionId: "claude-session-1",
          outcome: "success",
        }),
      ],
      [
        "lifecycle_fix_complete",
        expect.objectContaining({
          runner: "claude-sdk",
          sessionId: "claude-session-2",
          outcome: "success",
        }),
      ],
    ]);
  });

  test("repair fails closed when worker verification is absent", async () => {
    const task = makeTask();
    const mockQuery = makeMockQueryFn(mixedResponse(task.successCriteria, [0]));
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent.mockResolvedValue(
      makeAgentResult({ verification: null, claudeSessionId: "claude-unverified" }),
    );
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result).toMatchObject({
      verified: false,
      statusUpdated: false,
      fixAttemptsUsed: 2,
    });
    expect(mockSealAgentOutputAttempt).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((events.emit as ReturnType<typeof jest.fn>).mock.calls).toContainEqual([
      "session_error",
      expect.objectContaining({
        error: expect.stringContaining("without passing deterministic verification"),
        runner: "claude-sdk",
        sessionId: "claude-unverified",
      }),
    ]);
  });

  test("repair contains thrown Claude worker errors and never re-verifies or seals", async () => {
    const task = makeTask();
    const mockQuery = makeMockQueryFn(mixedResponse(task.successCriteria, [0]));
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent.mockRejectedValue(new Error("Claude provider unavailable"));
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result).toMatchObject({
      verified: false,
      statusUpdated: false,
      fixAttemptsUsed: 2,
    });
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockSealAgentOutputAttempt).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((events.emit as ReturnType<typeof jest.fn>).mock.calls).toContainEqual([
      "session_error",
      expect.objectContaining({
        error: expect.stringContaining("Claude provider unavailable"),
        failedStage: "lifecycle_fix",
        runner: "claude-sdk",
      }),
    ]);
  });

  test.each(["claude-sdk", "codex-cli"] as const)(
    "%s repair refuses to run without a canonically resolved task spec",
    async (runner) => {
      const task = makeTask();
      adapter.config.agent.runner = runner;
      const mockQuery = makeMockQueryFn(mixedResponse(task.successCriteria, [0]));
      _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
      mockResolveTaskFile.mockImplementationOnce(() => Promise.resolve(null as never));

      const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

      expect(result).toMatchObject({
        verified: false,
        statusUpdated: false,
        fixAttemptsUsed: 0,
      });
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockSealAgentOutputAttempt).not.toHaveBeenCalled();
      expect((events.emit as ReturnType<typeof jest.fn>).mock.calls).toContainEqual([
        "session_error",
        expect.objectContaining({
          error: expect.stringContaining("could not resolve the active task spec"),
          runner,
        }),
      ]);
    },
  );

  test("repair fails closed when sealing fails before adversarial re-verification", async () => {
    const task = makeTask();
    const mockQuery = makeMockQueryFn(mixedResponse(task.successCriteria, [0]));
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);
    mockRunAgent.mockResolvedValue(makeAgentResult({ claudeSessionId: "claude-seal" }));
    mockSealAgentOutputAttempt.mockRejectedValue(new Error("seal rejected protected output"));
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result).toMatchObject({
      verified: false,
      statusUpdated: false,
      fixAttemptsUsed: 2,
    });
    expect(mockRunAgent.mock.calls[1][3]).toMatchObject({
      resumeSessionId: "claude-seal",
    });
    expect(mockSealAgentOutputAttempt).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((events.emit as ReturnType<typeof jest.fn>).mock.calls).toContainEqual([
      "session_error",
      expect.objectContaining({
        error: expect.stringContaining("seal rejected protected output"),
        runner: "claude-sdk",
        sessionId: "claude-seal",
      }),
    ]);
  });

  // ── Test 3: Fix cycle exhausted (both attempts fail) ─────────────────

  test("fix cycle exhausted, both attempts fail", async () => {
    const task = makeTask();
    // All verifier calls return failures — verification never passes
    const failResponse = mixedResponse(task.successCriteria, [0, 1]);
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQuery = jest.fn().mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: failResponse,
      };
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.verified).toBe(false);
    expect(result.fixAttemptsUsed).toBe(2);
    expect(result.statusUpdated).toBe(false);
    // 3 calls: initial verify + one post-seal re-verification per worker attempt.
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockSealAgentOutputAttempt).toHaveBeenCalledTimes(2);
    const verificationNeededCalls = (events.emit as ReturnType<typeof jest.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "task_verification_needed",
    );
    expect(verificationNeededCalls).toHaveLength(0);
  });

  // ── Test 4: Status update changes READY to COMPLETE ──────────────────

  test("status update changes READY to COMPLETE", async () => {
    const task = makeTask();
    const response = allPassResponse(task.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // readFile: return written content if available, otherwise original
    mockReadFile.mockImplementation((filePath: string) => {
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    expect(result.statusUpdated).toBe(true);

    // Verify writeFile was called with COMPLETE status
    const writeFileCalls = mockWriteFile.mock.calls as Array<[string, string, string]>;
    const statusWriteCall = writeFileCalls.find(
      (call) => typeof call[1] === "string" && call[1].includes("**Status:** COMPLETE"),
    );
    expect(statusWriteCall).toBeDefined();
  });

  // ── Test 5: Verified.json entry written correctly ────────────────────

  test("does not write verified.json during pipeline completion and emits task_verification_needed", async () => {
    const task = makeTask();
    const response = allPassResponse(task.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    mockReadFile.mockImplementation((filePath: string) => {
      // Return written content if available (post-write verification)
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      return Promise.resolve(taskFileContent("TASK-100", "READY"));
    });

    await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    const writeFileCalls = mockWriteFile.mock.calls as Array<[string, string, string]>;
    const verifiedWriteCall = writeFileCalls.find(
      (call) => typeof call[0] === "string" && call[0].includes("verified.json"),
    );
    expect(verifiedWriteCall).toBeUndefined();

    const verificationNeededCalls = (events.emit as ReturnType<typeof jest.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "task_verification_needed",
    );
    expect(verificationNeededCalls).toHaveLength(1);
    expect(verificationNeededCalls[0][1]).toMatchObject({
      taskId: "TASK-100",
    });
  });

  // ── Test 6: Blocker resolution promotes blocked task ─────────────────

  test("blocker resolution promotes blocked task from BACKLOG to READY", async () => {
    // Task A (TASK-100) is COMPLETE and blocks TASK-101
    const taskA = makeTask({
      id: "TASK-100",
      blocks: ["TASK-101"],
    });

    const response = allPassResponse(taskA.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // readdir returns both task files
    mockReaddir.mockResolvedValue(["TASK-100.md", "TASK-101.md"]);

    // readFile: return different content based on path
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("verified.json")) {
        return Promise.reject(new Error("ENOENT"));
      }
      // Return written content if available (post-write verification)
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      if (filePath.includes("TASK-101")) {
        return Promise.resolve(
          taskFileContent("TASK-101", "BACKLOG", {
            blockedBy: ["TASK-100"],
          }),
        );
      }
      // TASK-100 and status update reads
      return Promise.resolve(
        taskFileContent("TASK-100", "READY", {
          blocks: ["TASK-101"],
        }),
      );
    });

    // parseTaskFile mock — use title line to distinguish
    mockParseTaskFile.mockImplementation((content: string) => {
      if (content.includes("# TASK-101")) {
        return makeTask({
          id: "TASK-101",
          status: "BACKLOG",
          blockedBy: ["TASK-100"],
        });
      }
      // blocker check reads TASK-100 back — it should be COMPLETE by now
      return makeTask({
        id: "TASK-100",
        status: "COMPLETE",
        blocks: ["TASK-101"],
      });
    });

    const result = await runPostApprovalLifecycle("TASK-100", taskA, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.blockersResolved).toContain("TASK-101");
  });

  // ── Test 7: Blocker resolution with partial blockers ─────────────────

  test("blocker resolution with partial blockers does not promote", async () => {
    // A blocks B, C blocks B. A is COMPLETE, C is IN_PROGRESS
    const taskA = makeTask({
      id: "TASK-100",
      blocks: ["TASK-102"],
    });

    const response = allPassResponse(taskA.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    mockReaddir.mockResolvedValue(["TASK-100.md", "TASK-101.md", "TASK-102.md"]);

    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("verified.json")) {
        return Promise.reject(new Error("ENOENT"));
      }
      // Return written content if available (post-write verification)
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      if (filePath.includes("TASK-102")) {
        return Promise.resolve(
          taskFileContent("TASK-102", "BACKLOG", {
            blockedBy: ["TASK-100", "TASK-101"],
          }),
        );
      }
      if (filePath.includes("TASK-101")) {
        return Promise.resolve(taskFileContent("TASK-101", "IN_PROGRESS"));
      }
      return Promise.resolve(
        taskFileContent("TASK-100", "READY", {
          blocks: ["TASK-102"],
        }),
      );
    });

    mockParseTaskFile.mockImplementation((content: string) => {
      if (content.includes("# TASK-102")) {
        return makeTask({
          id: "TASK-102",
          status: "BACKLOG",
          blockedBy: ["TASK-100", "TASK-101"],
        });
      }
      if (content.includes("# TASK-101")) {
        return makeTask({
          id: "TASK-101",
          status: "IN_PROGRESS",
        });
      }
      return makeTask({
        id: "TASK-100",
        status: "COMPLETE",
        blocks: ["TASK-102"],
      });
    });

    const result = await runPostApprovalLifecycle("TASK-100", taskA, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.blockersResolved).not.toContain("TASK-102");
    expect(result.blockersResolved).toEqual([]);
  });

  // ── Test 8: Parent completion when all siblings complete ─────────────

  test("parent completion when all siblings complete", async () => {
    // TASK-200 is parent. TASK-201 and TASK-202 are subtasks.
    // We're completing TASK-201; TASK-202 is already COMPLETE.
    const subtask = makeTask({
      id: "TASK-201",
      rawContent:
        "# TASK-201: Subtask 1\nParent Task: TASK-200\n## Metadata\n- **Status:** READY\n",
    });

    const response = allPassResponse(subtask.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // readdir returns parent + both subtasks
    mockReaddir.mockResolvedValue(["TASK-200.md", "TASK-201.md", "TASK-202.md"]);

    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("verified.json")) {
        return Promise.reject(new Error("ENOENT"));
      }
      // Return written content if available (post-write verification)
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      if (filePath.includes("TASK-200")) {
        return Promise.resolve(taskFileContent("TASK-200", "IN_PROGRESS"));
      }
      if (filePath.includes("TASK-201")) {
        return Promise.resolve(
          `# TASK-201: Subtask 1\nParent Task: TASK-200\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Status:** READY\n- **Blocked By:** []\n- **Blocks:** []\n\n## Success Criteria\n- [ ] Criterion 1\n`,
        );
      }
      if (filePath.includes("TASK-202")) {
        return Promise.resolve(
          `# TASK-202: Subtask 2\nParent Task: TASK-200\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Status:** COMPLETE\n- **Blocked By:** []\n- **Blocks:** []\n\n## Success Criteria\n- [ ] Criterion 1\n`,
        );
      }
      return Promise.resolve("");
    });

    // parseTaskFile for parent completion check — use title line to distinguish
    mockParseTaskFile.mockImplementation((content: string) => {
      if (content.includes("# TASK-200")) {
        return makeTask({ id: "TASK-200", status: "IN_PROGRESS" });
      }
      if (content.includes("# TASK-202")) {
        return makeTask({ id: "TASK-202", status: "COMPLETE" });
      }
      if (content.includes("# TASK-201")) {
        return makeTask({ id: "TASK-201", status: "COMPLETE" });
      }
      return makeTask();
    });

    const result = await runPostApprovalLifecycle("TASK-201", subtask, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.parentCompleted).toBe("TASK-200");
  });

  // ── Test 9: Parent not completed when siblings incomplete ────────────

  test("parent not completed when siblings incomplete", async () => {
    const subtask = makeTask({
      id: "TASK-201",
      rawContent:
        "# TASK-201: Subtask 1\nParent Task: TASK-200\n## Metadata\n- **Status:** READY\n",
    });

    const response = allPassResponse(subtask.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    mockReaddir.mockResolvedValue(["TASK-200.md", "TASK-201.md", "TASK-202.md"]);

    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("verified.json")) {
        return Promise.reject(new Error("ENOENT"));
      }
      // Return written content if available (post-write verification)
      if (writtenFiles.has(filePath)) {
        return Promise.resolve(writtenFiles.get(filePath)!);
      }
      if (filePath.includes("TASK-200")) {
        return Promise.resolve(taskFileContent("TASK-200", "IN_PROGRESS"));
      }
      if (filePath.includes("TASK-201")) {
        return Promise.resolve(
          `# TASK-201: Subtask 1\nParent Task: TASK-200\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Status:** READY\n- **Blocked By:** []\n- **Blocks:** []\n\n## Success Criteria\n- [ ] Criterion 1\n`,
        );
      }
      if (filePath.includes("TASK-202")) {
        return Promise.resolve(
          `# TASK-202: Subtask 2\nParent Task: TASK-200\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Status:** IN_PROGRESS\n- **Blocked By:** []\n- **Blocks:** []\n\n## Success Criteria\n- [ ] Criterion 1\n`,
        );
      }
      return Promise.resolve("");
    });

    mockParseTaskFile.mockImplementation((content: string) => {
      if (content.includes("# TASK-200")) {
        return makeTask({ id: "TASK-200", status: "IN_PROGRESS" });
      }
      if (content.includes("# TASK-202")) {
        return makeTask({ id: "TASK-202", status: "IN_PROGRESS" });
      }
      if (content.includes("# TASK-201")) {
        return makeTask({ id: "TASK-201", status: "COMPLETE" });
      }
      return makeTask();
    });

    const result = await runPostApprovalLifecycle("TASK-201", subtask, adapter, tmpDir, events);

    expect(result.verified).toBe(true);
    expect(result.parentCompleted).toBeNull();
  });

  // ── Test 10: SDK query failure is non-fatal ──────────────────────────

  test("SDK query failure is non-fatal", async () => {
    const task = makeTask();

    // Mock query that throws synchronously (caught by lifecycle try/catch)
    const mockQuery = jest.fn().mockImplementation(function () {
      throw new Error("SDK connection failed");
    });
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    // Should not throw
    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    // Verification failed but lifecycle didn't crash
    expect(result.verified).toBe(false);
    expect(result.statusUpdated).toBe(false);
  });

  // ── Test 11: Post-write verification detects stale status ───────────

  test("updateTaskStatus returns false when the canonical mutation fence refuses stale bytes", async () => {
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));
    mockWithCanonicalTaskSpecMutationFence.mockRejectedValueOnce(
      new Error("Task TASK-100 changed before its canonical mutation could be published."),
    );

    const updated = await updateTaskStatus(
      "TASK-100",
      "/tmp/lifecycle-test/docs/tasks",
      "COMPLETE",
      events,
      adapter,
    );

    expect(updated).toBe(false);

    // Verify lifecycle_status_update_failed event was emitted
    const failedCalls = (events.emit as ReturnType<typeof jest.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === "lifecycle_status_update_failed",
    );
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0][1]).toMatchObject({
      taskId: "TASK-100",
      expectedStatus: "COMPLETE",
    });
  });

  test("updateTaskStatus emits and logs when the Status line pattern does not match", async () => {
    const emit = jest.fn();
    const eventsForUpdate = {
      ...events,
      emit,
    } as unknown as IEventWriter;

    mockReadFile.mockResolvedValue(
      `# TASK-100: Test Task\n## Metadata\n- **Priority:** P2-MEDIUM\n`,
    );

    const updated = await updateTaskStatus(
      "TASK-100",
      "/tmp/lifecycle-test/docs/tasks",
      "COMPLETE",
      eventsForUpdate,
    );

    expect(updated).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockAppendFile).toHaveBeenCalled();

    const failedCalls = emit.mock.calls.filter(
      (call: unknown[]) => call[0] === "lifecycle_status_update_failed",
    );
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0][1]).toMatchObject({
      taskId: "TASK-100",
      expectedStatus: "COMPLETE",
    });
  });
});
