import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { assembleContext } from "../../src/dispatcher/context-assembler";
import type { AdapterConfig, ParsedTask } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";

// ─── Fixtures ──────────────────────────────────────────────────────────

const SAMPLE_PROJECT = path.resolve(__dirname, "..", "fixtures", "sample-project");

function makeAdapter(overrides?: Partial<ProjectAdapter>): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "sample-project",
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
    projectRoot: SAMPLE_PROJECT,
    conventionsDoc: "Use async/await. Follow kebab-case naming.",
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

function makeTask(overrides?: Partial<ParsedTask>): ParsedTask {
  return {
    id: "TASK-001",
    title: "Add token refresh",
    priority: "P1-HIGH",
    effort: "4-6 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["backend"],
    problemStatement: "Auth tokens never refresh.",
    currentState: "Token is static after login.",
    recommendedApproach: "Add a refresh endpoint.",
    filesToModify: [],
    successCriteria: ["Token refresh works"],
    testingRequirements: ["Unit tests for refresh"],
    contextReferences: [],
    rawContent: "# TASK-001: Add token refresh\n\nFull task content here.",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("assembleContext", () => {
  describe("taskSpec", () => {
    it("should use task.rawContent as taskSpec", async () => {
      const task = makeTask({ rawContent: "# TASK-042: Custom raw content" });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.taskSpec).toBe("# TASK-042: Custom raw content");
    });
  });

  describe("conventions", () => {
    it("should load convention documents referenced in task.conventions", async () => {
      const task = makeTask({ conventions: ["STYLE-001"] });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.conventions["STYLE-001"]).toBeDefined();
      expect(ctx.conventions["STYLE-001"]).toContain("Code Style Convention");
      expect(ctx.conventions["STYLE-001"]).toContain("kebab-case");
    });

    it("should return 'not found' for missing convention references", async () => {
      const task = makeTask({ conventions: ["NONEXISTENT-999"] });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.conventions["NONEXISTENT-999"]).toContain("Convention not found");
    });

    it("should return empty record when no conventions referenced", async () => {
      const task = makeTask({ conventions: [] });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(Object.keys(ctx.conventions)).toHaveLength(0);
    });
  });

  describe("conventionsSummary", () => {
    it("should use adapter.conventionsDoc", async () => {
      const task = makeTask();
      const adapter = makeAdapter({ conventionsDoc: "Custom conventions summary" });

      const ctx = await assembleContext(task, adapter);

      expect(ctx.conventionsSummary).toBe("Custom conventions summary");
    });
  });

  describe("relevantFiles", () => {
    it("should load files listed in filesToModify with Modify action", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Add refresh" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("src/services/auth.ts");
      expect(ctx.relevantFiles[0]).toContain("authenticate");
    });

    it("should note files marked as Create with 'file to be created'", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/refresh.ts", action: "Create", notes: "New file" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("file to be created");
    });

    it("should handle missing files gracefully with 'file not found'", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/services/nonexistent.ts", action: "Modify", notes: "Missing" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("file not found");
      expect(ctx.relevantFiles[0]).toContain("nonexistent.ts");
    });

    it("should skip binary file extensions", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "assets/logo.png", action: "Modify", notes: "Update logo" },
          { path: "src/services/auth.ts", action: "Modify", notes: "Add refresh" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // Should only include the .ts file, not the .png
      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("auth.ts");
    });

    it("should skip files in node_modules", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "node_modules/some-package/index.js", action: "Modify", notes: "Skip" },
          { path: "src/services/auth.ts", action: "Modify", notes: "Add refresh" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("auth.ts");
    });

    it("should load files marked as Delete", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Delete", notes: "Remove" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("authenticate");
    });
  });

  describe("relatedPatterns", () => {
    it("should find sibling files in the same directory", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // Should find users.ts as a sibling pattern file
      const hasUsersPattern = ctx.relatedPatterns.some(
        (p) => p.includes("users.ts") && p.includes("getUser"),
      );
      expect(hasUsersPattern).toBe(true);
    });

    it("should not duplicate files already in filesToModify", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/services/auth.ts", action: "Modify", notes: "Change" },
          { path: "src/services/users.ts", action: "Modify", notes: "Also change" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // Neither auth.ts nor users.ts should appear in relatedPatterns
      const hasAuthPattern = ctx.relatedPatterns.some((p) =>
        p.includes("--- src/services/auth.ts ---"),
      );
      const hasUsersPattern = ctx.relatedPatterns.some((p) =>
        p.includes("--- src/services/users.ts ---"),
      );
      expect(hasAuthPattern).toBe(false);
      expect(hasUsersPattern).toBe(false);
    });

    it("should limit pattern files to 5", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relatedPatterns.length).toBeLessThanOrEqual(5);
    });
  });

  describe("existingTests", () => {
    it("should find test files for modified source files", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // Should find tests/services/auth.test.ts
      const hasAuthTest = ctx.existingTests.some(
        (t) => t.includes("auth.test.ts") && t.includes("authenticate"),
      );
      expect(hasAuthTest).toBe(true);
    });

    it("should return empty array when no test files exist", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/utils/helpers.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // No test file exists for helpers.ts
      expect(ctx.existingTests).toHaveLength(0);
    });

    it("should not discover tests for non-src files", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "docs/conventions/STYLE-001.md", action: "Modify", notes: "Update" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.existingTests).toHaveLength(0);
    });
  });

  describe("claudeMd", () => {
    it("should discover CLAUDE.md at the project root", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      const hasRootClaudeMd = ctx.claudeMd.some(
        (c) => c.includes("CLAUDE.md") && c.includes("Sample Project"),
      );
      expect(hasRootClaudeMd).toBe(true);
    });

    it("should return empty array when no CLAUDE.md exists", async () => {
      const task = makeTask();
      // Point to a directory without CLAUDE.md
      const adapter = makeAdapter({
        projectRoot: path.join(SAMPLE_PROJECT, "src"),
      });

      const ctx = await assembleContext(task, adapter);

      // src/ has no CLAUDE.md
      const hasClaudeMd = ctx.claudeMd.some((c) => c.includes("CLAUDE.md"));
      expect(hasClaudeMd).toBe(false);
    });
  });

  describe("file size truncation", () => {
    const LARGE_FILE_DIR = path.resolve(
      __dirname,
      "..",
      "fixtures",
      "sample-project",
      "src",
      "services",
    );
    const LARGE_FILE_PATH = path.join(LARGE_FILE_DIR, "large-file.ts");

    beforeAll(async () => {
      // Create a file larger than 50KB
      const largeContent = "// " + "x".repeat(60 * 1024) + "\n";
      await fs.writeFile(LARGE_FILE_PATH, largeContent, "utf-8");
    });

    afterAll(async () => {
      // Clean up the large file
      try {
        await fs.unlink(LARGE_FILE_PATH);
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should truncate files exceeding 50KB with a truncation note", async () => {
      const task = makeTask({
        filesToModify: [
          { path: "src/services/large-file.ts", action: "Modify", notes: "Modify large file" },
        ],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("[truncated");
      expect(ctx.relevantFiles[0]).toContain("50KB");
    });
  });

  describe("auto-convention loading", () => {
    it("should load autoConventions even when task.conventions is empty", async () => {
      const task = makeTask({ conventions: [] });
      const adapter = makeAdapter({
        config: {
          ...makeAdapter().config,
          project: {
            ...makeAdapter().config.project,
            conventionsDir: ".quack",
            testPatterns: {
              testDir: "tests/",
              sourceDir: "src/",
              suffixes: [".test.ts"],
              prefixes: [],
              autoConventions: ["TESTING"],
            },
          },
        },
      });

      const ctx = await assembleContext(task, adapter);

      // TESTING convention should be loaded even though task doesn't reference it
      expect(ctx.conventions).toHaveProperty("TESTING");
      expect(ctx.conventions["TESTING"]).toContain("TESTING");
    });

    it("should deduplicate conventions between task and autoConventions", async () => {
      const task = makeTask({
        conventions: ["STYLE-001"],
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "" }],
      });
      const adapter = makeAdapter({
        config: {
          ...makeAdapter().config,
          project: {
            ...makeAdapter().config.project,
            conventionsDir: ".quack",
            testPatterns: {
              testDir: "tests/",
              sourceDir: "src/",
              suffixes: [".test.ts"],
              prefixes: [],
              autoConventions: ["TESTING"],
            },
          },
        },
      });

      const ctx = await assembleContext(task, adapter);

      // Both STYLE-001 (from task) and TESTING (from auto) should be present
      expect(Object.keys(ctx.conventions)).toContain("TESTING");
    });

    it("should not load autoConventions when testPatterns is undefined", async () => {
      const task = makeTask({ conventions: [] });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // No auto conventions — only task conventions (which is empty)
      expect(Object.keys(ctx.conventions)).toHaveLength(0);
    });
  });

  describe("sibling test discovery", () => {
    it("should find example test for Create actions", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/new-service.ts", action: "Create", notes: "" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // Should find auth.test.ts as a sibling example in tests/services/
      const siblingExample = ctx.existingTests.find((t) =>
        t.includes("[example test for reference]"),
      );
      expect(siblingExample).toBeDefined();
      expect(siblingExample).toContain("auth.test.ts");
    });

    it("should not find sibling tests for Modify actions", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      const siblingExample = ctx.existingTests.find((t) =>
        t.includes("[example test for reference]"),
      );
      expect(siblingExample).toBeUndefined();
    });
  });

  describe("lazy loading", () => {
    it("should include full contents for relevant_files (filesToModify)", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // relevantFiles should have full file content
      expect(ctx.relevantFiles).toHaveLength(1);
      expect(ctx.relevantFiles[0]).toContain("authenticate");
      expect(ctx.relevantFiles[0]).toContain("validateToken");
    });

    it("should include only exports summary for related patterns", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      // relatedPatterns should have export summaries, not full code
      const usersPattern = ctx.relatedPatterns.find((p) => p.includes("users.ts"));
      expect(usersPattern).toBeDefined();
      expect(usersPattern).toContain("Exports:");
      expect(usersPattern).toContain("getUser");
      // Should NOT contain full function body
      expect(usersPattern).not.toContain('email: "user@example.com"');
    });
  });

  describe("repoMap", () => {
    it("should include repo map when source files exist", async () => {
      const task = makeTask({
        filesToModify: [{ path: "src/services/auth.ts", action: "Modify", notes: "Change" }],
      });
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.repoMap).toBeDefined();
      expect(ctx.repoMap).toContain("## Repository Map");
      expect(ctx.repoMap).toContain("src/services/auth.ts");
      expect(ctx.repoMap).toContain("authenticate");
    });

    it("should not include repo map when no source files match", async () => {
      const task = makeTask();
      // Point to a directory with no src/ files
      const adapter = makeAdapter({
        projectRoot: path.join(SAMPLE_PROJECT, "docs"),
      });

      const ctx = await assembleContext(task, adapter);

      expect(ctx.repoMap).toBeUndefined();
    });
  });

  describe("blueprintPatterns", () => {
    it("should pass through blueprintPatterns when provided", async () => {
      const task = makeTask();
      const adapter = makeAdapter();
      const blueprintPatterns = [
        {
          criterion: "Export function validateEmail",
          checkType: "grep" as const,
          pattern: "export function validateEmail",
          fileGlob: "src/validators.ts",
        },
        {
          criterion: "Test file exists",
          checkType: "file_exists" as const,
          pattern: "tests/validators.test.ts",
          fileGlob: "",
        },
      ];

      const ctx = await assembleContext(task, adapter, undefined, { blueprintPatterns });

      expect(ctx.blueprintPatterns).toBeDefined();
      expect(ctx.blueprintPatterns).toHaveLength(2);
      expect(ctx.blueprintPatterns![0].criterion).toBe("Export function validateEmail");
      expect(ctx.blueprintPatterns![1].checkType).toBe("file_exists");
    });

    it("should not include blueprintPatterns when not provided", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter);

      expect(ctx.blueprintPatterns).toBeUndefined();
    });

    it("should not include blueprintPatterns when options is empty", async () => {
      const task = makeTask();
      const adapter = makeAdapter();

      const ctx = await assembleContext(task, adapter, undefined, {});

      expect(ctx.blueprintPatterns).toBeUndefined();
    });
  });

  describe("similarWork (template matching)", () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-context-similar-work-"));
    });

    afterEach(async () => {
      await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    async function writeSimilarWorkFixture(
      sourceFileName: string,
      sourceContent = "# TASK-015: Monitor Dashboard\nDashboard spec content.",
    ): Promise<void> {
      const templatesDir = path.join(projectRoot, ".quack", "templates");
      const logsDir = path.join(projectRoot, ".quack", "logs");
      const tasksDir = path.join(projectRoot, "docs", "tasks");
      await fs.mkdir(templatesDir, { recursive: true });
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.mkdir(logsDir, { recursive: true });

      const registry = {
        updatedAt: "2024-01-01T00:00:00Z",
        templates: [
          {
            category: "dashboard-feature",
            sourceTaskId: "TASK-015",
            specTemplate: "Add dashboard feature template...",
            successRate: 0.9,
            avgCostUsd: 5.0,
            filePatterns: ["src/monitor", "tests/monitor"],
            fileCount: 3,
            tags: ["dashboard", "ui"],
          },
        ],
        categoryStats: {
          "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "dashboard-feature": { count: 1, avgSuccessRate: 0.9, avgCostUsd: 5.0 },
          "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        },
      };
      await fs.writeFile(
        path.join(templatesDir, "task-templates.json"),
        JSON.stringify(registry, null, 2),
      );
      await fs.writeFile(path.join(tasksDir, sourceFileName), sourceContent);
      await fs.writeFile(
        path.join(logsDir, "TASK-015-final.diff"),
        "diff --git a/src/monitor/server.ts\n+added dashboard code\n",
      );
    }

    // Exact-name control: this is the pre-existing green arm for the retired construction.
    it("should include matched template in similarWork when match exists", async () => {
      await writeSimilarWorkFixture("TASK-015.md");
      const task = makeTask({
        tags: ["dashboard", "ui"],
        filesToModify: [
          { path: "src/monitor/new-widget.ts", action: "Create", notes: "New widget" },
        ],
      });
      const adapter = makeAdapter({ projectRoot });

      const ctx = await assembleContext(task, adapter);

      expect(ctx.similarWork).toBeDefined();
      expect(ctx.similarWork!.taskId).toBe("TASK-015");
      expect(ctx.similarWork!.category).toBe("dashboard-feature");
      expect(ctx.similarWork!.spec).toContain("Monitor Dashboard");
      expect(ctx.similarWork!.diff).toContain("added dashboard code");
      expect(ctx.similarWork!.matchReasons.length).toBeGreaterThan(0);
    });

    it("should populate similarWork.spec from a descriptive source filename", async () => {
      await writeSimilarWorkFixture("TASK-015-monitor-dashboard.md");
      const task = makeTask({
        tags: ["dashboard", "ui"],
        filesToModify: [
          { path: "src/monitor/new-widget.ts", action: "Create", notes: "New widget" },
        ],
      });

      const ctx = await assembleContext(task, makeAdapter({ projectRoot }));

      expect(ctx.similarWork).toBeDefined();
      expect(ctx.similarWork!.taskId).toBe("TASK-015");
      expect(ctx.similarWork!.spec).toContain("Monitor Dashboard");
      expect(ctx.similarWork!.diff).toContain("added dashboard code");
    });

    it("should truncate a large similarWork spec from a descriptive source filename", async () => {
      const largeSpec = [
        "# TASK-015: Monitor Dashboard",
        "Dashboard spec content.",
        "x".repeat(55 * 1024),
      ].join("\n");
      await writeSimilarWorkFixture("TASK-015-monitor-dashboard.md", largeSpec);
      const task = makeTask({
        tags: ["dashboard", "ui"],
        filesToModify: [
          { path: "src/monitor/new-widget.ts", action: "Create", notes: "New widget" },
        ],
      });

      const ctx = await assembleContext(task, makeAdapter({ projectRoot }));

      expect(ctx.similarWork).toBeDefined();
      expect(ctx.similarWork!.spec.slice(0, 50 * 1024)).toBe(largeSpec.slice(0, 50 * 1024));
      expect(ctx.similarWork!.spec).toContain("[truncated");
      expect(ctx.similarWork!.spec.length).toBeLessThan(largeSpec.length);
    });

    it("should not include similarWork when no template matches", async () => {
      await writeSimilarWorkFixture("TASK-015.md");
      const task = makeTask({
        tags: ["random-tag"],
        filesToModify: [{ path: "src/other/file.ts", action: "Create", notes: "" }],
        problemStatement: "Some unrelated task.",
      });
      const adapter = makeAdapter({ projectRoot });

      const ctx = await assembleContext(task, adapter);

      expect(ctx.similarWork).toBeUndefined();
    });
  });
});
