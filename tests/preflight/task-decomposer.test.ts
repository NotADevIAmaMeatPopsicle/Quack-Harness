// ─── Task Decomposer Tests ─────────────────────────────────────────

import { decomposeTask, _setQueryFn } from "../../src/preflight/task-decomposer.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";

describe("task-decomposer", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  describe("decomposeTask", () => {
    it("should produce 2-4 subtasks from a complex task", async () => {
      const task: ParsedTask = {
        id: "TASK-042",
        title: "Multi-Project Switcher",
        priority: "P1-HIGH",
        effort: "6-8 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test problem",
        currentState: "Test state",
        recommendedApproach: "Test approach",
        filesToModify: [
          { path: "src/types.ts", action: "Create", notes: "Types" },
          { path: "src/registry.ts", action: "Create", notes: "Registry" },
          { path: "src/api.ts", action: "Create", notes: "API" },
          { path: "tests/registry.test.ts", action: "Create", notes: "Tests" },
        ],
        successCriteria: [
          "Types defined",
          "Registry implemented",
          "API endpoints work",
          "Tests pass",
        ],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-042",
        fileAnalyses: [
          {
            filePath: "src/types.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "Existing types",
          },
          {
            filePath: "src/registry.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Imports from src/types.ts",
            patternToFollow: "Existing registries",
          },
          {
            filePath: "src/api.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Imports from src/registry.ts",
            patternToFollow: "Existing API",
          },
          {
            filePath: "tests/registry.test.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Tests src/registry.ts",
            patternToFollow: "Existing tests",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter: ProjectAdapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**", "tests/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "Test convention",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "Test CLAUDE.md",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      expect(result.parentTaskId).toBe("TASK-042");
      expect(result.subtasks.length).toBeGreaterThanOrEqual(2);
      expect(result.subtasks.length).toBeLessThanOrEqual(4);
    });

    it("should group related files into the same subtask", async () => {
      const task: ParsedTask = {
        id: "TASK-998",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/types.ts", action: "Create", notes: "" },
          { path: "src/impl.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["Criteria 1", "Criteria 2"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-998",
        fileAnalyses: [
          {
            filePath: "src/types.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
          {
            filePath: "src/impl.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Imports from src/types.ts",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Files that depend on each other should be in the same subtask
      expect(result.subtasks.length).toBeLessThanOrEqual(2);
    });

    it("should set final subtask flag correctly", async () => {
      const task: ParsedTask = {
        id: "TASK-998",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["Criteria 1", "Criteria 2"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-998",
        fileAnalyses: [
          {
            filePath: "src/a.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
          {
            filePath: "src/b.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Only the last subtask should be final
      const finalCount = result.subtasks.filter((s) => s.isFinal).length;
      expect(finalCount).toBe(1);
      expect(result.subtasks[result.subtasks.length - 1].isFinal).toBe(true);
    });

    it("should respect maxSubtasks limit", async () => {
      // Mock LLM response since 5 standalone files > maxSubtasks=2 triggers LLM fallback
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQueryFn = async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            subtasks: [
              {
                id: "TASK-998-A",
                title: "Group 1",
                filesToModify: [
                  { path: "src/a.ts", action: "Create", notes: "" },
                  { path: "src/b.ts", action: "Create", notes: "" },
                  { path: "src/c.ts", action: "Create", notes: "" },
                ],
                successCriteria: ["C1", "C2", "C3"],
                dependsOn: [],
                isFinal: false,
              },
              {
                id: "TASK-998-B",
                title: "Group 2",
                filesToModify: [
                  { path: "src/d.ts", action: "Create", notes: "" },
                  { path: "src/e.ts", action: "Create", notes: "" },
                ],
                successCriteria: ["C4", "C5"],
                dependsOn: ["TASK-998-A"],
                isFinal: true,
              },
            ],
          }),
        };
      };
      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const task: ParsedTask = {
        id: "TASK-998",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
          { path: "src/c.ts", action: "Create", notes: "" },
          { path: "src/d.ts", action: "Create", notes: "" },
          { path: "src/e.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["C1", "C2", "C3", "C4", "C5"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-998",
        fileAnalyses: task.filesToModify.map((f) => ({
          filePath: f.path,
          action: f.action,
          currentStructure: "[new file]",
          integrationPoints: "None",
          patternToFollow: "",
        })),
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint, { maxSubtasks: 2 });

      expect(result.subtasks.length).toBeLessThanOrEqual(2);
    });

    it("should include a coverage report in the topology result", async () => {
      const task: ParsedTask = {
        id: "TASK-555",
        title: "Coverage Report Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/alpha.ts", action: "Create", notes: "" },
          { path: "src/beta.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["Alpha works", "Beta works"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-555",
        fileAnalyses: [
          {
            filePath: "src/alpha.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
          {
            filePath: "src/beta.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Imports from src/alpha.ts",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: { requireCleanTree: true, protectedBranches: ["main"], allowedRemotes: ["origin"] },
          logging: { logDir: ".quack/logs", writeEvents: true },
          automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
          fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Coverage report must be present
      expect(result.coverageReport).toBeDefined();
      expect(result.coverageReport.fileOwnership).toBeDefined();
      expect(Array.isArray(result.coverageReport.unmappedFiles)).toBe(true);
      expect(Array.isArray(result.coverageReport.unmappedCriteria)).toBe(true);
      expect(typeof result.coverageReport.hasCoverageGap).toBe("boolean");

      // All files should be assigned to some subtask (no coverage gap)
      expect(result.coverageReport.unmappedFiles).not.toContain("src/alpha.ts");
      expect(result.coverageReport.unmappedFiles).not.toContain("src/beta.ts");
    });

    it("should report hasCoverageGap=false when all files and criteria are mapped", async () => {
      const task: ParsedTask = {
        id: "TASK-556",
        title: "Coverage Gap Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [{ path: "src/x.ts", action: "Create", notes: "" }],
        successCriteria: ["X works"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-556",
        fileAnalyses: [
          {
            filePath: "src/x.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: { requireCleanTree: true, protectedBranches: ["main"], allowedRemotes: ["origin"] },
          logging: { logDir: ".quack/logs", writeEvents: true },
          automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
          fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // With a single file in a single subtask, coverage should be complete
      expect(result.coverageReport.unmappedFiles).toHaveLength(0);
      expect(result.coverageReport.hasCoverageGap).toBe(false);
    });

    it("should use correct subtask ID naming convention", async () => {
      const task: ParsedTask = {
        id: "TASK-123",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["C1", "C2"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-123",
        fileAnalyses: task.filesToModify.map((f) => ({
          filePath: f.path,
          action: f.action,
          currentStructure: "[new file]",
          integrationPoints: "None",
          patternToFollow: "",
        })),
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Should follow TASK-123-A, TASK-123-B pattern
      for (const subtask of result.subtasks) {
        expect(subtask.id).toMatch(/^TASK-123-[A-Z]$/);
      }
    });

    it("should set dependencies between subtasks", async () => {
      const task: ParsedTask = {
        id: "TASK-998",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["C1", "C2"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-998",
        fileAnalyses: [
          {
            filePath: "src/a.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
          {
            filePath: "src/b.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Depends on src/a.ts",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: {
            requireCleanTree: true,
            protectedBranches: ["main"],
            allowedRemotes: ["origin"],
          },
          logging: {
            logDir: ".quack/logs",
            writeEvents: true,
          },
          automation: {
            autoPrep: {
              enabled: false,
              maxPerHour: 20,
              costLimitPerHour: 5.0,
            },
          },
          fleetBudget: {
            dailyLimit: 100,
            hourlyLimit: 10,
          },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: {
            enabled: false,
            fileHeartbeatIntervalMs: 30000,
            maxSilenceMs: 600000,
          },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // First subtask should have no dependencies
      expect(result.subtasks[0].dependsOn).toEqual([]);

      // Later subtasks should depend on earlier ones
      if (result.subtasks.length > 1) {
        expect(result.subtasks[1].dependsOn.length).toBeGreaterThan(0);
      }
    });

    it("should map success criteria to correct subtasks based on file names", async () => {
      const task: ParsedTask = {
        id: "TASK-100",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/registry.ts", action: "Create", notes: "" },
          { path: "src/api.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["Registry handles project lookup", "API endpoints return valid JSON"],
        testingRequirements: [],

        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-100",
        fileAnalyses: [
          {
            filePath: "src/registry.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
          {
            filePath: "src/api.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "None",
            patternToFollow: "",
          },
        ],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: { requireCleanTree: true, protectedBranches: ["main"], allowedRemotes: ["origin"] },
          logging: { logDir: ".quack/logs", writeEvents: true },
          automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
          fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Each subtask should have at least one criterion
      for (const subtask of result.subtasks) {
        expect(subtask.successCriteria.length).toBeGreaterThan(0);
      }
    });

    it("should add final verification criterion only to last subtask", async () => {
      const task: ParsedTask = {
        id: "TASK-200",
        title: "Test",
        priority: "P1-HIGH",
        effort: "4 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
          { path: "src/c.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["C1", "C2", "C3"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-200",
        fileAnalyses: task.filesToModify.map((f) => ({
          filePath: f.path,
          action: f.action,
          currentStructure: "[new file]",
          integrationPoints: "None",
          patternToFollow: "",
        })),
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: { requireCleanTree: true, protectedBranches: ["main"], allowedRemotes: ["origin"] },
          logging: { logDir: ".quack/logs", writeEvents: true },
          automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
          fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      const result = await decomposeTask(task, adapter, blueprint);

      // Only the last subtask should have the integration criterion
      const nonFinal = result.subtasks.slice(0, -1);
      const final = result.subtasks[result.subtasks.length - 1];

      for (const subtask of nonFinal) {
        expect(subtask.successCriteria).not.toContain("All parent task success criteria verified");
        expect(subtask.isFinal).toBe(false);
      }

      expect(final.isFinal).toBe(true);
      expect(final.successCriteria).toContain("All parent task success criteria verified");
    });

    it("should fallback to LLM decomposition when clustering fails", async () => {
      // When there are too many clusters, the decomposer falls back to LLM
      const task: ParsedTask = {
        id: "TASK-300",
        title: "Test",
        priority: "P1-HIGH",
        effort: "8 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "" },
          { path: "src/b.ts", action: "Create", notes: "" },
          { path: "src/c.ts", action: "Create", notes: "" },
          { path: "src/d.ts", action: "Create", notes: "" },
          { path: "src/e.ts", action: "Create", notes: "" },
          { path: "src/f.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["C1", "C2", "C3", "C4", "C5", "C6"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-300",
        fileAnalyses: task.filesToModify.map((f) => ({
          filePath: f.path,
          action: f.action,
          currentStructure: "[new file]",
          integrationPoints: "None",
          patternToFollow: "",
        })),
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      // Mock LLM response for decomposition
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQueryFn = async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            subtasks: [
              {
                id: "TASK-300-A",
                title: "Foundation",
                filesToModify: [
                  { path: "src/a.ts", action: "Create", notes: "" },
                  { path: "src/b.ts", action: "Create", notes: "" },
                ],
                successCriteria: ["C1", "C2"],
                dependsOn: [],
                isFinal: false,
              },
              {
                id: "TASK-300-B",
                title: "Integration",
                filesToModify: [
                  { path: "src/c.ts", action: "Create", notes: "" },
                  { path: "src/d.ts", action: "Create", notes: "" },
                ],
                successCriteria: ["C3", "C4"],
                dependsOn: ["TASK-300-A"],
                isFinal: false,
              },
              {
                id: "TASK-300-C",
                title: "Final",
                filesToModify: [
                  { path: "src/e.ts", action: "Create", notes: "" },
                  { path: "src/f.ts", action: "Create", notes: "" },
                ],
                successCriteria: ["C5", "C6"],
                dependsOn: ["TASK-300-B"],
                isFinal: true,
              },
            ],
          }),
        };
      };

      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const adapter = {
        projectRoot: "/test",
        config: {
          project: {
            name: "test",
            root: "/test",
            taskDir: "docs/tasks",
            conventionsDir: "docs/conventions",
          },
          modelRouting: {
            gateModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            plannerModel: "claude-sonnet-4-20250514",
            workerModel: "claude-sonnet-4-20250514",
            workerComplexModel: "claude-opus-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            retryEscalation: false,
          },
          agent: {
            model: "claude-sonnet-4-20250514",
            judgeModel: "claude-sonnet-4-20250514",
            enrichModel: "claude-sonnet-4-20250514",
            maxTurns: 100,
            maxBudgetPerTask: 10,
            maxRetries: 1,
          },
          verification: { commands: [], conventionChecks: [] },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
          git: { requireCleanTree: true, protectedBranches: ["main"], allowedRemotes: ["origin"] },
          logging: { logDir: ".quack/logs", writeEvents: true },
          automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
          fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
          costVelocity: {
            enabled: false,
            alertThreshold: 2.0,
            killThreshold: 5.0,
            windowMinutes: 15,
          },
          stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
          docker: {
            enabled: false,
            image: "node:18",
            memoryLimitMb: 2048,
            cpuLimit: 2.0,
            timeoutMinutes: 60,
          },
          queue: {
            enabled: false,
            maxConcurrent: 3,
            autoPause: { onFailure: true, afterCount: 1 },
            persistence: { enabled: true, file: ".quack/queue/state.json" },
          },
          preflight: {
            autoRun: false,
            complexityThresholds: {
              maxFilesBeforeDecompose: 6,
              maxCriteriaBeforeDecompose: 8,
              maxContextTokensBeforeDecompose: 35000,
              maxIndependentFeatures: 3,
            },
          },
        },
        conventionsDoc: "",
        judgeCriteria: "",
        conventionCheckScripts: [],
        adrDocs: {},
        claudeMd: "",
      } as unknown as ProjectAdapter;

      // maxSubtasks=2 forces clustering to fail (6 independent files = 6 clusters > 2)
      const result = await decomposeTask(task, adapter, blueprint, { maxSubtasks: 2 });

      expect(result.subtasks.length).toBeLessThanOrEqual(2);
      expect(result.parentTaskId).toBe("TASK-300");
    });
  });
});
