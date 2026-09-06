import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { IEventWriter } from "../../src/monitor/event-emitter.js";

// ─── Mocks ─────────────────────────────────────────────────────────

jest.mock("node:child_process", () => ({
  execSync: jest.fn().mockReturnValue("abc1234"),
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
jest.mock("../../src/core/task-file-resolver", () => ({
  listDuplicateClaimants: jest.fn(() => Promise.resolve([])),
  resolveTaskFile: jest.fn(async (taskDir: string, taskId: string) => {
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
  }),
}));

jest.mock("../../src/core/task-parser", () => ({
  parseTaskFile: jest.fn(),
}));

jest.mock("../../src/core/task-state-overlay.js", () => ({
  ...jest.requireActual<object>("../../src/core/task-state-overlay"),
  loadTaskStateOverlay: jest.fn(() => ({
    overlay: new Map<string, string>(),
    degraded: false,
    source: "absent",
    viaWorktree: false,
    resolvedRoot: "C:\\tmp\\lifecycle-test",
    requestedRoot: "C:\\tmp\\lifecycle-test",
  })),
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

  test("adversarial verification finds issues, fix cycle succeeds", async () => {
    const task = makeTask();
    let callCount = 0;

    // First call: verify fails (2 failures)
    // Second call: fix agent runs (consumed, no result needed)
    // Third call: verify passes
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
      } else if (callCount === 2) {
        // Fix agent — just complete
        yield { type: "result", subtype: "success", result: "Fixed the issues" };
      } else {
        // Second adversarial verification — all pass
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
    expect(mockQuery).toHaveBeenCalledTimes(3); // verify + fix + re-verify
  });

  // ── Test 3: Fix cycle exhausted (both attempts fail) ─────────────────

  test("fix cycle exhausted, both attempts fail", async () => {
    const task = makeTask();
    // All calls return failures — verification never passes
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
    // 5 calls: initial verify + (fix1 + verify1) + (fix2 + verify2)
    expect(mockQuery).toHaveBeenCalledTimes(5);
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

  test("updateTaskStatus returns false when post-write re-read shows stale status", async () => {
    const task = makeTask();
    const response = allPassResponse(task.successCriteria);
    const mockQuery = makeMockQueryFn(response);
    _setQueryFn(mockQuery as unknown as Parameters<typeof _setQueryFn>[0]);

    // writeFile succeeds but does NOT update writtenFiles, so the re-read
    // still returns the original content with the old status.
    mockWriteFile.mockResolvedValue(undefined);

    // readFile always returns original content (simulating a write that
    // didn't actually persist — e.g., filesystem corruption or race).
    mockReadFile.mockResolvedValue(taskFileContent("TASK-100", "READY"));

    const result = await runPostApprovalLifecycle("TASK-100", task, adapter, tmpDir, events);

    // Verification passed but status update should have failed
    expect(result.verified).toBe(true);
    expect(result.statusUpdated).toBe(false);

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
