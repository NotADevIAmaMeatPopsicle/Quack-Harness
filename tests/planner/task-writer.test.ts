import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  writeTaskFiles,
  createTaskFilesFromInput,
  TaskCreateConflictError,
  TaskCreateValidationError,
  type TaskSpec,
} from "../../src/planner/task-writer.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";

describe("task-writer", () => {
  let tempDir: string;
  let mockAdapter: ProjectAdapter;

  beforeEach(async () => {
    // Create a temporary directory for test files
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
        commands: [],
        conventionChecks: [],
      },
      sandbox: {
        writablePaths: ["src/**", "tests/**", "docs/**"],
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
      conventionsDoc: "Test conventions",
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
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("writes valid task specs to files", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Test Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4-6 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** test
- **Conventions:** []

## Problem Statement
This is a test task.

## Current State
Nothing exists yet.

## Recommended Approach
Build it step by step.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test file |
| tests/test.test.ts | Create | Test file tests |

## Success Criteria
- [ ] Feature works
- [ ] Tests pass

## Testing Requirements
- [ ] Unit tests pass
- [ ] Integration tests pass

## Context References
- None`,
      },
    ];

    const taskIds = await writeTaskFiles(taskSpecs, mockAdapter);

    expect(taskIds).toEqual(["TASK-001"]);

    // Verify file was written
    const taskDir = path.join(tempDir, "docs", "tasks");
    const files = await fs.readdir(taskDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^TASK-001-.+\.md$/);

    // Verify content
    const content = await fs.readFile(path.join(taskDir, files[0]), "utf-8");
    expect(content).toContain("# TASK-001: Test Task");
  });

  test("validates all specs before writing any files", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Valid Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Valid task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/valid.ts | Create | Valid |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
      {
        id: "TASK-002",
        content: `# TASK-002: Invalid Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY

## Problem Statement
Missing required fields`,
      },
    ];

    await expect(writeTaskFiles(taskSpecs, mockAdapter)).rejects.toThrow("Task validation failed");

    // Verify NO files were written (atomic validation)
    const taskDir = path.join(tempDir, "docs", "tasks");
    const exists = await fs.stat(taskDir).catch(() => null);
    if (exists) {
      const files = await fs.readdir(taskDir);
      expect(files).toHaveLength(0);
    }
  });

  test("validates file paths are within writable paths", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Invalid Path Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Task with invalid file path

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| /etc/passwd | Modify | NOT ALLOWED |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await expect(writeTaskFiles(taskSpecs, mockAdapter)).rejects.toThrow(
      "is not within writable paths",
    );
  });

  test("validates dependency references have correct format", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Invalid Dependency

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** [INVALID-REF]
- **Blocks:** []

## Problem Statement
Task with invalid dependency reference

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await expect(writeTaskFiles(taskSpecs, mockAdapter)).rejects.toThrow(
      "Invalid blockedBy reference",
    );
  });

  test("creates task directory if it doesn't exist", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Test Task

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 1 hour
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Test

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    // Task directory shouldn't exist yet
    const taskDir = path.join(tempDir, "docs", "tasks");
    const existsBefore = await fs.stat(taskDir).catch(() => null);
    expect(existsBefore).toBeNull();

    await writeTaskFiles(taskSpecs, mockAdapter);

    // Task directory should now exist
    const existsAfter = await fs.stat(taskDir);
    expect(existsAfter.isDirectory()).toBe(true);
  });

  test("rejects tasks with dependencies referencing non-existent task IDs", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Task With Bad Dep

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** [TASK-999]
- **Blocks:** []

## Problem Statement
References a task that does not exist

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await expect(writeTaskFiles(taskSpecs, mockAdapter)).rejects.toThrow("non-existent task ID");
  });

  test("accepts tasks with dependencies referencing other generated tasks", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: First Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** [TASK-002]

## Problem Statement
First task that blocks second

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/first.ts | Create | First |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
      {
        id: "TASK-002",
        content: `# TASK-002: Second Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** [TASK-001]
- **Blocks:** []

## Problem Statement
Second task blocked by first

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/second.ts | Create | Second |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    const ids = await writeTaskFiles(taskSpecs, mockAdapter);
    expect(ids).toEqual(["TASK-001", "TASK-002"]);
  });

  test("accepts dependencies referencing existing task files", async () => {
    // Create an existing task file in the task directory
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, "TASK-010-existing.md"), "# existing");

    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-011",
        content: `# TASK-011: Depends On Existing

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** [TASK-010]
- **Blocks:** []

## Problem Statement
Depends on an existing task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/dep.ts | Create | Dep |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    const ids = await writeTaskFiles(taskSpecs, mockAdapter);
    expect(ids).toEqual(["TASK-011"]);
  });

  test("createTaskFilesFromInput creates task specs from structured payload", async () => {
    const result = await createTaskFilesFromInput(
      [
        {
          id: "TASK-120",
          title: "Structured task",
          priority: "P2-MEDIUM",
          effort: "2 hours",
          status: "READY",
          blockedBy: [],
          blocks: [],
          tags: ["api"],
          problemStatement: "Need native task create",
          currentState: "No endpoint exists",
          recommendedApproach: "Expose POST endpoint",
          successCriteria: ["Task is created"],
          testingRequirements: ["Task writer test passes"],
        },
      ],
      mockAdapter,
    );

    expect(result.taskIds).toEqual(["TASK-120"]);
    expect(result.filePaths[0]).toContain("TASK-120");
  });

  test("createTaskFilesFromInput throws validation errors for bad payload", async () => {
    await expect(
      createTaskFilesFromInput(
        [
          {
            id: "INVALID",
            title: "",
            priority: "P9-WRONG",
          },
        ],
        mockAdapter,
      ),
    ).rejects.toBeInstanceOf(TaskCreateValidationError);
  });

  test("createTaskFilesFromInput throws conflict errors for existing IDs", async () => {
    await writeTaskFiles(
      [
        {
          id: "TASK-130",
          content: `# TASK-130: Existing Task

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 1 hour
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Already present.

## Success Criteria
- [ ] Exists

## Testing Requirements
- [ ] Exists`,
        },
      ],
      mockAdapter,
    );

    await expect(
      createTaskFilesFromInput(
        [
          {
            id: "TASK-130",
            title: "Duplicate",
            priority: "P2-MEDIUM",
            effort: "1 hour",
            status: "READY",
            problemStatement: "Duplicate",
            successCriteria: ["Should fail"],
            testingRequirements: ["Should fail"],
          },
        ],
        mockAdapter,
      ),
    ).rejects.toBeInstanceOf(TaskCreateConflictError);
  });

  test("lock file prevents concurrent writes", async () => {
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });

    // Pre-create a lock file to simulate a concurrent operation
    const lockPath = path.join(taskDir, ".plan.lock");
    await fs.writeFile(lockPath, "fake-lock");

    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Blocked By Lock

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 1 hour
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Should fail because lock exists

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await expect(writeTaskFiles(taskSpecs, mockAdapter)).rejects.toThrow(
      "Another plan operation is in progress",
    );

    // Clean up lock so afterEach can remove the dir
    await fs.unlink(lockPath);
  });

  test("lock file is cleaned up after successful write", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Lock Cleanup Test

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 1 hour
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Lock should be cleaned up after write

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await writeTaskFiles(taskSpecs, mockAdapter);

    // Lock file should not exist after completion
    const taskDir = path.join(tempDir, "docs", "tasks");
    const lockPath = path.join(taskDir, ".plan.lock");
    const lockExists = await fs.stat(lockPath).catch(() => null);
    expect(lockExists).toBeNull();
  });

  test("generates slug from task title for filename", async () => {
    const taskSpecs: TaskSpec[] = [
      {
        id: "TASK-001",
        content: `# TASK-001: Complex Task Title with Special Characters!

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []

## Problem Statement
Test slug generation

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/test.ts | Create | Test |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      },
    ];

    await writeTaskFiles(taskSpecs, mockAdapter);

    const taskDir = path.join(tempDir, "docs", "tasks");
    const files = await fs.readdir(taskDir);
    expect(files[0]).toMatch(/^TASK-001-complex-task-title-with-special-characters\.md$/);
  });
});
