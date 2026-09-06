import { planTasks, _setQueryFn } from "../../src/planner/planner-agent.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";

describe("planner-agent", () => {
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

  const mockAdapter: ProjectAdapter = {
    projectRoot: "/test/project",
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

  beforeEach(() => {
    // Reset the query function before each test
    _setQueryFn(undefined);
  });

  afterEach(() => {
    // Clean up after each test
    _setQueryFn(undefined);
  });

  test("returns generated task IDs and specs in dry-run mode", async () => {
    // Mock the SDK query function
    const mockQueryFn = function* () {
      yield { type: "assistant_message" };
      yield {
        type: "result",
        subtype: "success",
        result: `Here are the generated tasks:

\`\`\`markdown
# TASK-001: Implement User Authentication

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 6-8 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** auth, backend
- **Conventions:** []

## Problem Statement
Add user authentication to the application.

## Current State
No authentication system exists.

## Recommended Approach
Use JWT tokens for authentication.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/auth/auth.ts | Create | Authentication service |
| tests/auth/auth.test.ts | Create | Tests |

## Success Criteria
- [ ] Users can sign up
- [ ] Users can log in

## Testing Requirements
- [ ] Unit tests pass
- [ ] Integration tests pass

## Context References
- ADR-001: Authentication strategy
\`\`\``,
      };
    };

    _setQueryFn(mockQueryFn as never);

    const result = await planTasks("Add user authentication", mockAdapter, {
      dryRun: true,
    });

    expect(result.taskIds).toEqual(["TASK-001"]);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]).toContain("# TASK-001: Implement User Authentication");
  });

  test("handles multiple task specs in response", async () => {
    const mockQueryFn = function* () {
      yield { type: "assistant_message" };
      yield {
        type: "result",
        subtype: "success",
        result: `\`\`\`markdown
# TASK-001: Backend API

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** [TASK-002]
- **Tags:** backend

## Problem Statement
Build backend API

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/api.ts | Create | API |

## Success Criteria
- [ ] API works

## Testing Requirements
- [ ] Tests pass
\`\`\`

\`\`\`markdown
# TASK-002: Frontend UI

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** READY
- **Blocked By:** [TASK-001]
- **Blocks:** []
- **Tags:** frontend

## Problem Statement
Build frontend UI

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/ui.tsx | Create | UI |

## Success Criteria
- [ ] UI works

## Testing Requirements
- [ ] Tests pass
\`\`\``,
      };
    };

    _setQueryFn(mockQueryFn as never);

    const result = await planTasks("Build full-stack app", mockAdapter, {
      dryRun: true,
    });

    expect(result.taskIds).toEqual(["TASK-001", "TASK-002"]);
    expect(result.specs).toHaveLength(2);
  });

  test("throws error on SDK error result", async () => {
    const mockQueryFn = function* () {
      yield {
        type: "result",
        subtype: "error_max_turns",
        errors: ["Max turns exceeded"],
        total_cost_usd: 0.5,
        num_turns: 25,
        stop_reason: "max_turns",
      };
    };

    _setQueryFn(mockQueryFn as never);

    await expect(planTasks("Add feature", mockAdapter, { dryRun: true })).rejects.toThrow(
      "Planner agent SDK error: error_max_turns",
    );
  });

  test("throws error when no result returned", async () => {
    const mockQueryFn = function* () {
      yield { type: "assistant_message" };
      // No result message
    };

    _setQueryFn(mockQueryFn as never);

    await expect(planTasks("Add feature", mockAdapter, { dryRun: true })).rejects.toThrow(
      "Planner agent returned no success result",
    );
  });

  test("enforces maxTasks limit when LLM returns more tasks than requested", async () => {
    const mockQueryFn = function* () {
      yield {
        type: "result",
        subtype: "success",
        result: `\`\`\`markdown
# TASK-001: Task One

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** one

## Problem Statement
First task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/one.ts | Create | One |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass
\`\`\`

\`\`\`markdown
# TASK-002: Task Two

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** two

## Problem Statement
Second task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/two.ts | Create | Two |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass
\`\`\`

\`\`\`markdown
# TASK-003: Task Three

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** three

## Problem Statement
Third task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/three.ts | Create | Three |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass
\`\`\``,
      };
    };

    _setQueryFn(mockQueryFn as never);

    const result = await planTasks("Build three things", mockAdapter, {
      dryRun: true,
      maxTasks: 2,
    });

    // Should only return 2 tasks despite LLM generating 3
    expect(result.taskIds).toHaveLength(2);
    expect(result.taskIds).toEqual(["TASK-001", "TASK-002"]);
    expect(result.specs).toHaveLength(2);
  });

  test("handles task spec without code blocks", async () => {
    const mockQueryFn = function* () {
      yield {
        type: "result",
        subtype: "success",
        result: `# TASK-001: Simple Task

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** simple

## Problem Statement
Simple task

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/simple.ts | Create | Simple |

## Success Criteria
- [ ] Works

## Testing Requirements
- [ ] Tests pass`,
      };
    };

    _setQueryFn(mockQueryFn as never);

    const result = await planTasks("Simple task", mockAdapter, { dryRun: true });

    expect(result.taskIds).toEqual(["TASK-001"]);
    expect(result.specs[0]).toContain("# TASK-001: Simple Task");
  });
});
