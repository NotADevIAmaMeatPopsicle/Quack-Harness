import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type {
  AdapterConfig,
  GateResult,
  ParsedTask,
  SchemaCheckResult,
  TaskContext,
} from "../../src/core/types";

// ─── Mock gate, dispatcher, schema validator, and context assembler ──

const mockRunReadinessGate = jest.fn<
  Promise<GateResult>,
  [ParsedTask, ProjectAdapter, Record<string, unknown>?]
>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (...args: [ParsedTask, ProjectAdapter, Record<string, unknown>?]) =>
    mockRunReadinessGate(...args),
}));

const mockValidateTaskSchema = jest.fn<SchemaCheckResult, [ParsedTask]>();
jest.mock("../../src/gate/schema-validator", () => ({
  validateTaskSchema: (...args: [ParsedTask]) => mockValidateTaskSchema(...args),
}));

const mockAssembleContext = jest.fn<Promise<TaskContext>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/dispatcher/context-assembler", () => ({
  assembleContext: (...args: [ParsedTask, ProjectAdapter]) => mockAssembleContext(...args),
}));

// Mock dispatchTask to verify it is NOT called during dry-run
const mockDispatchTask = jest.fn();
jest.mock("../../src/dispatcher/dispatcher", () => ({
  dispatchTask: (...args: unknown[]) => mockDispatchTask(...args) as unknown,
}));

// ─── Test helpers ──────────────────────────────────────────────────────

function makeAdapterConfig(): AdapterConfig {
  return {
    version: "1.0",
    project: {
      name: "test-project",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [{ name: "tests", command: "npm test", required: true, timeout: 300 }],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: ["npm test *"],
      deniedBashPatterns: ["rm *"],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 30,
    },
  };
}

function makeTaskContent(taskId: string, title: string): string {
  return `# ${taskId}: ${title}

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** BACKLOG
- **Blocked By:** []
- **Tags:** [test]

## Problem Statement
Test problem statement.

## Current State
Current state.

## Recommended Approach
Recommended approach.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test file |

## Success Criteria
- [ ] Test criterion 1
- [ ] Test criterion 2

## Testing Requirements
- [ ] Test requirement
`;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("dry-run mode", () => {
  let tmpDir: string;
  let exitCode: number | undefined;
  let consoleOutput: string[];
  let logSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create temp directory with adapter and task
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-dryrun-test-"));

    const quackDir = path.join(tmpDir, ".quack");
    await fs.mkdir(quackDir, { recursive: true });
    await fs.writeFile(path.join(quackDir, "adapter.json"), JSON.stringify(makeAdapterConfig()));

    const taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(
      path.join(taskDir, "TASK-042-test.md"),
      makeTaskContent("TASK-042", "Test Task"),
    );

    // Capture console output
    consoleOutput = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });

    // Mock process.exit
    exitCode = undefined;
    exitSpy = jest.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("should display task info without executing dispatch", async () => {
    // Mock gate to pass
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    // Mock context assembly
    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: { "ADR-001": "Convention text" },
      conventionsSummary: "Conventions summary",
      relevantFiles: ["src/test.ts"],
      relatedPatterns: [],
      existingTests: ["tests/test.test.ts"],
      claudeMd: ["--- CLAUDE.md ---\nContent"],
    });

    // Import after mocking
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, project: tmpDir });

    // Should NOT call dispatchTask
    expect(mockDispatchTask).not.toHaveBeenCalled();

    // Should have called gate
    expect(mockRunReadinessGate).toHaveBeenCalled();

    // Should have assembled context
    expect(mockAssembleContext).toHaveBeenCalled();

    // Should exit with 0
    expect(exitCode).toBe(0);

    // Output should include task info
    const output = consoleOutput.join("\n");
    expect(output).toContain("TASK-042");
    expect(output).toContain("Test Task");
    expect(output).toContain("P1-HIGH");
    expect(output).toContain("Dry run complete");
  });

  test("should show gate result in dry-run output", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, project: tmpDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Gate: PASS");
  });

  test("should show context summary in dry-run output", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: { "conv-a": "a", "conv-b": "b" },
      conventionsSummary: "",
      relevantFiles: ["file1.ts", "file2.ts", "file3.ts"],
      relatedPatterns: ["pattern1.ts"],
      existingTests: ["test1.test.ts", "test2.test.ts"],
      claudeMd: ["--- CLAUDE.md ---"],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, project: tmpDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Conventions: 2 loaded");
    expect(output).toContain("Relevant files: 3");
    expect(output).toContain("Related patterns: 1");
    expect(output).toContain("Existing tests: 2");
    expect(output).toContain("CLAUDE.md files: 1");
  });

  test("should show files to modify in dry-run output", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, project: tmpDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("[Create] src/test.ts");
  });

  test("should show success criteria in dry-run output", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, project: tmpDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Test criterion 1");
    expect(output).toContain("Test criterion 2");
  });

  test("should skip LLM gate when --skip-gate is set", async () => {
    // Mock schema validator (deterministic, still runs)
    mockValidateTaskSchema.mockReturnValue({
      valid: true,
      missing: [],
      warnings: ["files_to_modify (minimum 1 recommended)"],
    });

    // Mock context assembly
    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: { "ADR-001": "Convention text" },
      conventionsSummary: "Conventions summary",
      relevantFiles: ["src/test.ts"],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: ["--- CLAUDE.md ---\nContent"],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, skipGate: true, project: tmpDir });

    // Should NOT call the LLM readiness gate
    expect(mockRunReadinessGate).not.toHaveBeenCalled();

    // Should call the schema validator
    expect(mockValidateTaskSchema).toHaveBeenCalled();

    // Should still assemble context
    expect(mockAssembleContext).toHaveBeenCalled();

    // Should NOT call dispatchTask
    expect(mockDispatchTask).not.toHaveBeenCalled();

    // Should exit with 0
    expect(exitCode).toBe(0);

    // Output should show gate was skipped with schema warnings
    const output = consoleOutput.join("\n");
    expect(output).toContain("SKIPPED (--skip-gate)");
    expect(output).toContain("Schema warnings:");
    expect(output).toContain("files_to_modify");
    expect(output).toContain("Dry run complete");
  });

  test("should show schema pass when --skip-gate and no issues", async () => {
    mockValidateTaskSchema.mockReturnValue({
      valid: true,
      missing: [],
      warnings: [],
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, skipGate: true, project: tmpDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("SKIPPED (--skip-gate)");
    expect(output).toContain("Schema: PASS (no errors or warnings)");
  });

  test("should support --skip-depth-only in dry-run mode", async () => {
    mockRunReadinessGate.mockResolvedValue({
      outcome: "pass",
      task: {} as ParsedTask,
    });

    mockAssembleContext.mockResolvedValue({
      taskSpec: "Task spec",
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
      claudeMd: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runCommand } = require("../../src/cli/run") as typeof import("../../src/cli/run");

    await runCommand("TASK-042", { dryRun: true, skipDepthOnly: true, project: tmpDir });

    expect(mockRunReadinessGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ skipDepthOnly: true }),
    );

    const output = consoleOutput.join("\n");
    expect(output).toContain("Mode: SKIP DEPTH ONLY (--skip-depth-only)");
    expect(output).toContain("Gate: PASS");
  });
});
