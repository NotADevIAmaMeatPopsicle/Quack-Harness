/**
 * Integration tests for the planner agent
 * Tests the full flow: planner -> task writer -> schema validator -> task parser
 */

import { jest } from "@jest/globals";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { planTasks, _setQueryFn } from "../../src/planner/planner-agent.js";
import { validateTaskSchema } from "../../src/gate/schema-validator.js";
import { parseTaskFile } from "../../src/core/task-parser.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";

// Mock the Agent SDK to avoid real LLM calls in tests
jest.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: jest.fn(),
}));

describe("Planner Integration Tests", () => {
  let tempDir: string;
  let mockAdapter: ProjectAdapter;
  let taskDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test task files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "planner-test-"));
    taskDir = path.join(tempDir, "tasks");

    const config: AdapterConfig = {
      version: "1.0",
      project: {
        name: "Test Project",
        root: ".",
        taskDir: "tasks",
        conventionsDir: "conventions",
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
          {
            name: "tests",
            command: "npm test",
            required: true,
            timeout: 60000,
          },
          {
            name: "build",
            command: "npm run build",
            required: true,
            timeout: 60000,
          },
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

    // Create task directory
    await fs.mkdir(taskDir, { recursive: true });

    // Create a sample CLAUDE.md
    await fs.writeFile(
      path.join(tempDir, "CLAUDE.md"),
      "# Test Project\n\nA test project for planner integration testing.",
    );

    // Create a sample existing task for reference
    await fs.writeFile(
      path.join(taskDir, "TASK-001.md"),
      `# TASK-001: Sample Task

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** sample

## Problem Statement
This is a sample task for testing.

## Success Criteria
- [ ] Sample criterion met

## Testing Requirements
- [ ] Tests pass
`,
    );
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("generates a valid task spec that passes schema validation and parsing", async () => {
    // Mock the query function to return a valid task spec in the expected format
    const mockQuery = jest.fn();

    // Create an async generator that yields result message
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* mockGenerator() {
      yield {
        type: "result",
        subtype: "success",
        result: `\`\`\`markdown
# TASK-002: Implement User Authentication

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** authentication, security, backend

## Problem Statement
The application currently lacks user authentication. Users cannot log in, register, or maintain sessions.

## Current State
No authentication system exists. The app has no user model, no login endpoints, and no session management.

## Recommended Approach
1. Create a User model in the database
2. Implement registration endpoint
3. Implement login endpoint with JWT
4. Add session middleware
5. Protect authenticated routes

## Files to Modify

| File | Action | Notes |
|------|--------|-------|
| src/models/user.ts | Create | User model with email and password fields |
| src/routes/auth.ts | Create | Authentication routes |
| src/middleware/auth.ts | Create | JWT verification middleware |
| tests/routes/auth.test.ts | Create | Integration tests for auth endpoints |

## Success Criteria
- [ ] Users can register with email and password
- [ ] Users can log in and receive a JWT token
- [ ] Protected routes reject unauthenticated requests
- [ ] JWT tokens expire after 24 hours

## Testing Requirements
- [ ] Integration tests for registration endpoint
- [ ] Integration tests for login endpoint
- [ ] Unit tests for JWT middleware
- [ ] All existing tests continue to pass

## Context References
- CLAUDE.md
- src/models/
\`\`\``,
      };
    }

    mockQuery.mockReturnValue(mockGenerator());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    _setQueryFn(mockQuery as any);

    // Run the planner
    const result = await planTasks("Add user authentication to the application", mockAdapter, {
      maxTasks: 1,
      dryRun: false,
      model: "claude-sonnet-4-20250514",
    });

    // Verify the planner succeeded
    expect(result.taskIds).toHaveLength(1);
    expect(result.taskIds[0]).toBe("TASK-002");

    // Find the generated task file (filename includes slugified title)
    const taskFiles = await fs.readdir(taskDir);
    const task002File = taskFiles.find((f) => f.startsWith("TASK-002-"));
    expect(task002File).toBeDefined();

    const taskFilePath = path.join(taskDir, task002File!);
    const taskContent = await fs.readFile(taskFilePath, "utf-8");

    // INTEGRATION TEST 1: Parse through real task parser
    const parsedTask = parseTaskFile(taskContent, taskFilePath);
    expect(parsedTask).toBeDefined();
    expect(parsedTask.id).toBe("TASK-002");
    expect(parsedTask.title).toBe("Implement User Authentication");
    expect(parsedTask.priority).toBe("P1-HIGH");
    expect(parsedTask.effort).toBe("4 hours");
    expect(parsedTask.status).toBe("READY");
    expect(parsedTask.problemStatement).toContain("authentication");
    expect(parsedTask.successCriteria.length).toBeGreaterThanOrEqual(1);
    expect(parsedTask.testingRequirements.length).toBeGreaterThanOrEqual(1);

    // INTEGRATION TEST 2: Validate through real schema validator
    const schemaValidation = validateTaskSchema(parsedTask);
    expect(schemaValidation.valid).toBe(true);
    expect(schemaValidation.missing).toHaveLength(0);

    // Clean up
    _setQueryFn(undefined);
  });

  it("generates multiple tasks that all pass validation and parsing", async () => {
    // Mock the query function to return multiple task specs
    const mockQuery = jest.fn();

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* mockGenerator() {
      yield {
        type: "result",
        subtype: "success",
        result: `\`\`\`markdown
# TASK-002: Create Shopping Cart Database Model

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** [TASK-003]
- **Tags:** database, cart

## Problem Statement
The application needs a database model to store shopping cart items.

## Current State
No cart model exists.

## Recommended Approach
Create a Cart model with items array.

## Files to Modify

| File | Action | Notes |
|------|--------|-------|
| src/models/cart.ts | Create | Cart model |

## Success Criteria
- [ ] Cart model created
- [ ] Schema migrations run

## Testing Requirements
- [ ] Unit tests for cart model
\`\`\`

\`\`\`markdown
# TASK-003: Implement Cart API Endpoints

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** BACKLOG
- **Blocked By:** [TASK-002]
- **Blocks:** []
- **Tags:** api, cart

## Problem Statement
Users need API endpoints to add, remove, and view cart items.

## Current State
No cart endpoints exist.

## Recommended Approach
Create REST endpoints for cart operations.

## Files to Modify

| File | Action | Notes |
|------|--------|-------|
| src/routes/cart.ts | Create | Cart routes |

## Success Criteria
- [ ] Add to cart endpoint works

## Testing Requirements
- [ ] Integration tests for cart endpoints
\`\`\``,
      };
    }

    mockQuery.mockReturnValue(mockGenerator());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    _setQueryFn(mockQuery as any);

    // Run the planner
    const result = await planTasks("Build a shopping cart feature", mockAdapter, {
      maxTasks: 5,
      dryRun: false,
      model: "claude-sonnet-4-20250514",
    });

    // Verify the planner succeeded
    expect(result.taskIds).toHaveLength(2);
    expect(result.taskIds).toContain("TASK-002");
    expect(result.taskIds).toContain("TASK-003");

    // Validate each generated task through real validators and parsers
    const taskFiles = await fs.readdir(taskDir);
    for (const taskId of result.taskIds) {
      const taskFile = taskFiles.find((f) => f.startsWith(`${taskId}-`));
      expect(taskFile).toBeDefined();

      const taskFilePath = path.join(taskDir, taskFile!);
      const taskContent = await fs.readFile(taskFilePath, "utf-8");

      // Task parsing
      const parsedTask = parseTaskFile(taskContent, taskFilePath);
      expect(parsedTask).toBeDefined();
      expect(parsedTask.id).toBe(taskId);
      expect(parsedTask.successCriteria.length).toBeGreaterThanOrEqual(1);
      expect(parsedTask.testingRequirements.length).toBeGreaterThanOrEqual(1);

      // Schema validation
      const schemaValidation = validateTaskSchema(parsedTask);
      expect(schemaValidation.valid).toBe(true);
    }

    // Clean up
    _setQueryFn(undefined);
  });

  it("handles dependency chains correctly in generated specs", async () => {
    // Mock the query function to return tasks with dependencies
    const mockQuery = jest.fn();

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* mockGenerator() {
      yield {
        type: "result",
        subtype: "success",
        result: `\`\`\`markdown
# TASK-002: Database Schema

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** [TASK-003]
- **Tags:** database

## Problem Statement
Need database schema.

## Success Criteria
- [ ] Schema created

## Testing Requirements
- [ ] Schema tests pass
\`\`\`

\`\`\`markdown
# TASK-003: API Implementation

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 3 hours
- **Status:** BACKLOG
- **Blocked By:** [TASK-002]
- **Blocks:** []
- **Tags:** api

## Problem Statement
Need API that uses the schema.

## Success Criteria
- [ ] API works

## Testing Requirements
- [ ] API tests pass
\`\`\``,
      };
    }

    mockQuery.mockReturnValue(mockGenerator());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    _setQueryFn(mockQuery as any);

    const result = await planTasks("Build API with database", mockAdapter, {
      maxTasks: 2,
      dryRun: false,
      model: "claude-sonnet-4-20250514",
    });

    expect(result.taskIds).toHaveLength(2);

    // Parse both tasks - find the actual filenames
    const taskFiles = await fs.readdir(taskDir);
    const task002File = taskFiles.find((f) => f.startsWith("TASK-002-"));
    const task003File = taskFiles.find((f) => f.startsWith("TASK-003-"));
    expect(task002File).toBeDefined();
    expect(task003File).toBeDefined();

    const task002Path = path.join(taskDir, task002File!);
    const task003Path = path.join(taskDir, task003File!);

    const task002Content = await fs.readFile(task002Path, "utf-8");
    const task003Content = await fs.readFile(task003Path, "utf-8");

    const task002 = parseTaskFile(task002Content, task002Path);
    const task003 = parseTaskFile(task003Content, task003Path);

    // Verify dependency chain
    expect(task002.blockedBy).toHaveLength(0);
    expect(task002.blocks).toContain("TASK-003");
    expect(task003.blockedBy).toContain("TASK-002");
    expect(task003.status).toBe("BACKLOG");

    // Clean up
    _setQueryFn(undefined);
  });
});
