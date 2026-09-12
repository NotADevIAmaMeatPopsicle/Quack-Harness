import { buildSystemPrompt, buildTaskPrompt } from "../../src/worker/prompt-builder";
import type { AdapterConfig, TaskContext } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

// ─── Helpers ──────────────────────────────────────────────────────

function makeAdapter(overrides?: Partial<ProjectAdapter>): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "test-project",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
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

  return {
    config,
    projectRoot: "/tmp/test",
    conventionsDoc: "Use async/await. Follow kebab-case.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

function makeContext(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskSpec: "# TASK-042: Add caching\n\nImplement prompt caching.",
    conventions: {
      "STYLE-001": "Use kebab-case file names.",
    },
    conventionsSummary: "Use async/await. Follow project conventions.",
    relevantFiles: ["--- src/worker/agent.ts ---\nexport function run() {}"],
    relatedPatterns: ["--- src/worker/utils.ts ---\nexport function helper() {}"],
    existingTests: ["--- tests/worker/agent.test.ts ---\ndescribe('run', () => {});"],
    claudeMd: ["--- CLAUDE.md ---\n# Project Guide"],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("should include core agent instructions", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Quack Agent");
    expect(result).toContain("background coding agent");
  });

  it("should include project conventions", () => {
    const adapter = makeAdapter({ conventionsDoc: "Always use TypeScript strict mode." });
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Project Conventions");
    expect(result).toContain("Always use TypeScript strict mode.");
  });

  it("should include CLAUDE.md content", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, ["--- CLAUDE.md ---\n# Test Project"]);

    expect(result).toContain("Project Documentation (CLAUDE.md)");
    expect(result).toContain("Test Project");
  });

  it("should include runtime path authority after project docs", () => {
    const adapter = makeAdapter({ projectRoot: "C:\\repo\\.quack\\worktrees\\TASK-123" });
    const result = buildSystemPrompt(adapter, [
      "--- CLAUDE.md ---\nMigration note: use /root/example-service on Headnode.",
    ]);

    const docsPos = result.indexOf("Project Documentation (CLAUDE.md)");
    const pathPos = result.indexOf("Runtime Path Authority");
    const gitPos = result.indexOf("## Git Commit Format");

    expect(pathPos).toBeGreaterThan(docsPos);
    expect(pathPos).toBeLessThan(gitPos);
    expect(result).toContain("C:\\repo\\.quack\\worktrees\\TASK-123");
    expect(result).toContain("Do not read, write, search, or cd into those paths");
  });

  it("should include git commit format", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Git Commit Format");
    expect(result).toContain("[{taskId}] {message}");
  });

  it("should describe the sealer as the commit path", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("post-worker output sealer");
    expect(result).not.toContain("use `git_add` for ALL modified and created files");
    expect(result).not.toContain("use `git_commit` with the project's commit format");
  });
});

describe("buildTaskPrompt", () => {
  describe("cache-friendly ordering", () => {
    it("should place conventions summary before task spec", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const conventionsPos = result.indexOf("Conventions Summary");
      const taskSpecPos = result.indexOf("Task Specification");

      expect(conventionsPos).toBeGreaterThan(-1);
      expect(taskSpecPos).toBeGreaterThan(-1);
      expect(conventionsPos).toBeLessThan(taskSpecPos);
    });

    it("should place referenced conventions before task spec", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const referencedConventionsPos = result.indexOf("Referenced Conventions");
      const taskSpecPos = result.indexOf("Task Specification");

      expect(referencedConventionsPos).toBeGreaterThan(-1);
      expect(taskSpecPos).toBeGreaterThan(-1);
      expect(referencedConventionsPos).toBeLessThan(taskSpecPos);
    });

    it("should place task spec before code context", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const taskSpecPos = result.indexOf("Task Specification");
      const codeContextPos = result.indexOf("Existing Code Context");

      expect(taskSpecPos).toBeGreaterThan(-1);
      expect(codeContextPos).toBeGreaterThan(-1);
      expect(taskSpecPos).toBeLessThan(codeContextPos);
    });

    it("should place code context before related patterns", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const codeContextPos = result.indexOf("Existing Code Context");
      const patternsPos = result.indexOf("Related Patterns");

      expect(codeContextPos).toBeGreaterThan(-1);
      expect(patternsPos).toBeGreaterThan(-1);
      expect(codeContextPos).toBeLessThan(patternsPos);
    });

    it("should place related patterns before test files", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const patternsPos = result.indexOf("Related Patterns");
      const testsPos = result.indexOf("Related Test Files");

      expect(patternsPos).toBeGreaterThan(-1);
      expect(testsPos).toBeGreaterThan(-1);
      expect(patternsPos).toBeLessThan(testsPos);
    });

    it("should end with instructions section", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const instructionsPos = result.indexOf("## Instructions");
      const testsPos = result.indexOf("Related Test Files");

      expect(instructionsPos).toBeGreaterThan(testsPos);
    });

    it("full ordering: conventions > task spec > code > patterns > tests > instructions", () => {
      const context = makeContext();
      const result = buildTaskPrompt("TASK-042", context);

      const positions = {
        conventionsSummary: result.indexOf("Conventions Summary"),
        referencedConventions: result.indexOf("Referenced Conventions"),
        taskSpec: result.indexOf("Task Specification"),
        codeContext: result.indexOf("Existing Code Context"),
        patterns: result.indexOf("Related Patterns"),
        tests: result.indexOf("Related Test Files"),
        instructions: result.indexOf("## Instructions"),
      };

      // Verify the complete ordering
      expect(positions.conventionsSummary).toBeLessThan(positions.referencedConventions);
      expect(positions.referencedConventions).toBeLessThan(positions.taskSpec);
      expect(positions.taskSpec).toBeLessThan(positions.codeContext);
      expect(positions.codeContext).toBeLessThan(positions.patterns);
      expect(positions.patterns).toBeLessThan(positions.tests);
      expect(positions.tests).toBeLessThan(positions.instructions);
    });
  });

  it("should omit sections with empty content", () => {
    const context = makeContext({
      conventions: {},
      conventionsSummary: "",
      relevantFiles: [],
      relatedPatterns: [],
      existingTests: [],
    });
    const result = buildTaskPrompt("TASK-042", context);

    expect(result).not.toContain("Referenced Conventions");
    expect(result).not.toContain("Conventions Summary");
    expect(result).not.toContain("Existing Code Context");
    expect(result).not.toContain("Related Patterns");
    expect(result).not.toContain("Related Test Files");
    expect(result).toContain("Task Specification");
    expect(result).toContain("Instructions");
  });

  it("should include the task ID in the prompt", () => {
    const context = makeContext();
    const result = buildTaskPrompt("TASK-042", context);

    expect(result).toContain("TASK-042");
  });

  it("should forbid manual git commits in finishing instructions", () => {
    const context = makeContext();
    const result = buildTaskPrompt("TASK-042", context);

    expect(result).toContain("the post-worker output sealer is the only commit writer");
    expect(result).not.toContain("Use `git_add` to stage all changed files");
    expect(result).not.toContain("Use `git_commit` with the project's commit format");
  });

  describe("blueprint integration", () => {
    it("should include blueprint section when blueprint is present", () => {
      const context = makeContext({
        blueprint: "## Implementation Blueprint\n\nDetailed implementation plan here.",
      });
      const result = buildTaskPrompt("TASK-042", context);

      expect(result).toContain("Implementation Blueprint");
      expect(result).toContain("Detailed implementation plan here");
    });

    it("should place blueprint section after task spec and before repo map", () => {
      const context = makeContext({
        blueprint: "## Implementation Blueprint\n\nBlueprint content.",
        repoMap: "## Repository Map\n\nRepo map content.",
      });
      const result = buildTaskPrompt("TASK-042", context);

      const taskSpecPos = result.indexOf("Task Specification");
      const blueprintPos = result.indexOf("Implementation Blueprint");
      const repoMapPos = result.indexOf("Repository Map");

      expect(taskSpecPos).toBeGreaterThan(-1);
      expect(blueprintPos).toBeGreaterThan(-1);
      expect(repoMapPos).toBeGreaterThan(-1);
      expect(taskSpecPos).toBeLessThan(blueprintPos);
      expect(blueprintPos).toBeLessThan(repoMapPos);
    });

    it("should use blueprint-aware instructions when blueprint is present", () => {
      const context = makeContext({
        blueprint: "## Implementation Blueprint\n\nContent.",
      });
      const result = buildTaskPrompt("TASK-042", context);

      expect(result).toContain("Follow the Implementation Blueprint as your primary guide");
      expect(result).not.toContain("Follow ALL success criteria");
    });

    it("should use standard instructions when blueprint is absent", () => {
      const context = makeContext({
        blueprint: undefined,
      });
      const result = buildTaskPrompt("TASK-042", context);

      expect(result).toContain("Follow ALL success criteria");
      expect(result).not.toContain("Follow the Implementation Blueprint");
    });

    it("should not include blueprint section when blueprint is undefined", () => {
      const context = makeContext({
        blueprint: undefined,
      });
      const result = buildTaskPrompt("TASK-042", context);

      expect(result).not.toContain("Implementation Blueprint");
    });

    it("should preserve section ordering with blueprint: conventions > task > blueprint > repo > code > patterns > tests", () => {
      const context = makeContext({
        blueprint: "## Implementation Blueprint\n\nContent.",
        repoMap: "## Repository Map\n\nMap content.",
      });
      const result = buildTaskPrompt("TASK-042", context);

      const positions = {
        conventionsSummary: result.indexOf("Conventions Summary"),
        referencedConventions: result.indexOf("Referenced Conventions"),
        taskSpec: result.indexOf("Task Specification"),
        blueprint: result.indexOf("Implementation Blueprint"),
        repoMap: result.indexOf("Repository Map"),
        codeContext: result.indexOf("Existing Code Context"),
        patterns: result.indexOf("Related Patterns"),
        tests: result.indexOf("Related Test Files"),
      };

      expect(positions.conventionsSummary).toBeLessThan(positions.referencedConventions);
      expect(positions.referencedConventions).toBeLessThan(positions.taskSpec);
      expect(positions.taskSpec).toBeLessThan(positions.blueprint);
      expect(positions.blueprint).toBeLessThan(positions.repoMap);
      expect(positions.repoMap).toBeLessThan(positions.codeContext);
      expect(positions.codeContext).toBeLessThan(positions.patterns);
      expect(positions.patterns).toBeLessThan(positions.tests);
    });
  });
});

describe("contract alignment rules", () => {
  it("should include contract alignment section for frontend + backend tasks", () => {
    const context = makeContext({
      taskSpec: "# TASK-204-A: Implement frontends/admin/moderation/types.ts",
      relevantFiles: [
        "--- src/src/models/moderation-flag.model.js ---\nENUM('content', 'behavior')",
      ],
    });
    const result = buildTaskPrompt("TASK-204-A", context);

    expect(result).toContain("Contract Alignment Rules");
    expect(result).toContain("READ the backend model file");
    expect(result).toContain("NEVER invent field names");
  });

  it("should NOT include contract alignment for backend-only tasks", () => {
    const context = makeContext({
      taskSpec: "# TASK-202-A: Implement src/services/admin.service.js",
      relevantFiles: ["--- src/repositories/user.repo.js ---\nmodule.exports = UserRepository;"],
    });
    const result = buildTaskPrompt("TASK-202-A", context);

    expect(result).not.toContain("Contract Alignment Rules");
  });

  it("should NOT include contract alignment for frontend-only tasks with no backend source", () => {
    const context = makeContext({
      taskSpec: "# TASK-300: Implement frontends/admin/Button.tsx",
      relevantFiles: ["--- frontends/shared/utils.ts ---\nexport function formatDate() {}"],
    });
    const result = buildTaskPrompt("TASK-300", context);

    expect(result).not.toContain("Contract Alignment Rules");
  });

  it("should detect frontend via .tsx files in relevantFiles", () => {
    const context = makeContext({
      taskSpec: "# TASK-204-B: Implement moderation UI component",
      relevantFiles: [
        "--- components/ModerationPanel.tsx ---\nexport default ModerationPanel;",
        "--- src/src/dto/moderation-flag.dto.js ---\nmodule.exports = ModerationFlagDTO;",
      ],
    });
    const result = buildTaskPrompt("TASK-204-B", context);

    expect(result).toContain("Contract Alignment Rules");
  });

  it("should detect backend source from task spec mentioning dto paths", () => {
    const context = makeContext({
      taskSpec:
        "# TASK-204-C: Update frontends/admin types to match src/src/dto/announcement.dto.js",
      relevantFiles: [],
    });
    const result = buildTaskPrompt("TASK-204-C", context);

    expect(result).toContain("Contract Alignment Rules");
  });

  it("should place contract alignment after test files and before instructions", () => {
    const context = makeContext({
      taskSpec: "# TASK-204-A: Implement frontends/admin/moderation/types.ts",
      relevantFiles: [
        "--- src/src/models/moderation-flag.model.js ---\nENUM('content', 'behavior')",
      ],
    });
    const result = buildTaskPrompt("TASK-204-A", context);

    const contractPos = result.indexOf("Contract Alignment Rules");
    const instructionsPos = result.indexOf("## Instructions");

    expect(contractPos).toBeGreaterThan(-1);
    expect(instructionsPos).toBeGreaterThan(-1);
    expect(contractPos).toBeLessThan(instructionsPos);
  });
});

describe("CORE_AGENT_INSTRUCTIONS", () => {
  it("should contain Blueprint Execution section", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("## Blueprint Execution");
  });

  it("should contain primary guide instruction", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("blueprint is your primary guide");
  });

  it("should contain do not explore instruction", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Do NOT explore or search for integration points");
  });

  it("should contain follow pattern exactly instruction", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("follow that pattern exactly");
  });

  it("should contain proceed normally fallback for no blueprint", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("proceed normally");
  });

  it("should contain Stuck-Loop Detection section", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("## Stuck-Loop Detection");
  });

  it("should contain Approaches Tried in PROGRESS.md template", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("## Approaches Tried");
  });
});
