import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { buildPlannerPrompt } from "../../src/planner/planner-prompt.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe("planner-prompt", () => {
  let tempDir: string;
  let mockAdapter: ProjectAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-test-"));

    const config: AdapterConfig = {
      version: "1.0",
      project: {
        name: "Test Project",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {
        model: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 75,
        maxBudgetPerTask: 5,
        maxRetries: 3,
      },
      verification: {
        commands: [
          { name: "test", command: "npm test", required: true, timeout: 60000 },
          { name: "lint", command: "npm run lint", required: true, timeout: 30000 },
        ],
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
        commitTrailer: "Automated-By: Quack",
        autoCreatePr: false,
        autoPush: false,
      },
      logging: {
        dir: ".quack/logs",
        level: "info",
        retainDays: 30,
      },
    };

    mockAdapter = {
      projectRoot: tempDir,
      conventionsDoc: "# Project Conventions\n\nFollow these patterns...",
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
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("includes user prompt in the output", async () => {
    const prompt = await buildPlannerPrompt("Add user authentication system", mockAdapter);

    expect(prompt).toContain("Add user authentication system");
    expect(prompt).toContain("## User Prompt");
  });

  test("includes project configuration details", async () => {
    const prompt = await buildPlannerPrompt("Build feature X", mockAdapter);

    expect(prompt).toContain("Test Project");
    expect(prompt).toContain("docs/tasks");
    expect(prompt).toContain("docs/conventions");
    expect(prompt).toContain("src/**, tests/**");
  });

  test("includes verification commands", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("test, lint");
  });

  test("includes project conventions", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("# Project Conventions");
    expect(prompt).toContain("Follow these patterns...");
  });

  test("sets correct task ID start when provided", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter, 10, 42);

    expect(prompt).toContain("TASK-042");
  });

  test("auto-detects next task ID from existing files", async () => {
    // Create task directory with existing tasks
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, "TASK-001-first.md"), taskSpec("TASK-001"));
    await fs.writeFile(path.join(taskDir, "TASK-005-fifth.md"), taskSpec("TASK-005"));

    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    // Should start from 6 (max existing + 1)
    expect(prompt).toContain("TASK-006");
  });

  test("uses task ID 001 when no existing tasks", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("TASK-001");
  });

  test("respects maxTasks parameter", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter, 5);

    expect(prompt).toContain("1-5 discrete");
    expect(prompt).toContain("up to 5 tasks");
  });

  test("uses default maxTasks of 10", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("1-10 discrete");
    expect(prompt).toContain("up to 10 tasks");
  });

  test("includes example task from existing files", async () => {
    // Create a completed task as example
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    const exampleTask = `# TASK-001: Example Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** COMPLETE

## Problem Statement
Example problem

## Success Criteria
- [ ] Example criterion

## Testing Requirements
- [ ] Example test`;

    await fs.writeFile(path.join(taskDir, "TASK-001-example.md"), exampleTask);

    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("# TASK-001: Example Task");
    expect(prompt).toContain("**Status:** COMPLETE");
  });

  test("handles missing task directory gracefully", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    // Should not throw and should start from TASK-001
    expect(prompt).toContain("TASK-001");
    expect(prompt).toBeDefined();
  });

  test("includes test patterns configuration", async () => {
    mockAdapter.config.project.testPatterns = {
      testDir: "tests/",
      sourceDir: "src/",
      suffixes: [".test.ts", ".spec.ts"],
      prefixes: ["test_"],
      autoConventions: [],
    };

    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("tests/");
    expect(prompt).toContain(".test.ts, .spec.ts");
  });

  test("includes task format instructions", async () => {
    const prompt = await buildPlannerPrompt("Add feature", mockAdapter);

    expect(prompt).toContain("## Metadata");
    expect(prompt).toContain("## Problem Statement");
    expect(prompt).toContain("## Success Criteria");
    expect(prompt).toContain("## Testing Requirements");
  });
});
