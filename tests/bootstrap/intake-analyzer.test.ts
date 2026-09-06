import { analyzeIntake, _setQueryFn } from "../../src/bootstrap/intake-analyzer";
import type { ScanResult } from "../../src/bootstrap/project-scanner";
import type { CommandValidation } from "../../src/bootstrap/intake-types";

describe("intake-analyzer", () => {
  const mockScan: ScanResult = {
    projectPath: "/test",
    projectName: "test-project",
    language: "node",
    testCommand: "npm test",
    testFrameworks: [{ name: "jest", configFile: "jest.config.js" }],
    buildTools: [],
    sourceDirs: ["src/"],
    docFiles: [],
    readmeContent: "",
    claudeMdContent: "",
    hasExistingQuackDir: false,
    hasTypeScript: true,
    hasDocker: false,
    hasEnvExample: false,
    taskLocations: [],
    adrLocations: [],
    architectureDocs: [],
    conventionFiles: [],
    linters: [],
    ciPipelines: [],
    databaseConfigs: [],
    containerConfigs: [],
    frameworkType: "express",
    apiPatterns: [],
    isMonorepo: false,
    workspaces: [],
    runtimeTargets: [],
    scriptCommands: {
      test: "jest",
      "test:unit": "jest --testPathPattern=unit",
      build: "tsc",
    },
    testFileCount: 50,
    testSuiteSize: "medium",
    availableTestScripts: [
      { name: "test", command: "jest" },
      { name: "test:unit", command: "jest --testPathPattern=unit" },
    ],
    gitDefaultBranch: "main",
    gitRemoteUrl: "https://github.com/test/test-repo.git",
    gitHubOwner: "test",
    gitHubRepo: "test-repo",
  };

  const mockValidation: CommandValidation[] = [
    {
      name: "tests",
      command: "npm test",
      exitCode: 0,
      durationMs: 1500,
      stdout: "Tests: 10 passed, 10 total",
      stderr: "",
      testCount: 10,
      status: "pass",
    },
    {
      name: "build",
      command: "npm run build",
      exitCode: 0,
      durationMs: 800,
      stdout: "Build successful",
      stderr: "",
      status: "pass",
    },
  ];

  beforeEach(() => {
    // Mock the query function to return different responses for each call
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const mockQueryFn = async function* (): AsyncGenerator<{ type: string; text: string }, void> {
      callCount++;
      if (callCount === 1) {
        // Testing strategy response
        yield {
          type: "text",
          text: JSON.stringify({
            primaryCommand: {
              command: "npm run test:unit",
              rationale: "Faster unit tests for quick feedback",
            },
            targetedCommand: {
              command: "npm test -- --changedSince=HEAD~1",
              rationale: "Run only tests related to changes",
            },
            fullSuiteCommand: {
              command: "npm test",
              rationale: "Full suite for comprehensive validation",
            },
            estimatedFullSuiteTime: "~2 minutes",
            recommendations: [
              "Consider using targeted testing for faster feedback",
              "Run full suite before merging",
            ],
          }),
        };
      } else if (callCount === 2) {
        // Conventions analysis response
        yield {
          type: "text",
          text: "# Conventions\n\nThis is a generated conventions document.",
        };
      } else {
        // Adapter review response
        yield {
          type: "text",
          text: JSON.stringify({
            suggestions: ["Review writable paths", "Consider targeted testing"],
            confidence: "high",
          }),
        };
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    _setQueryFn(mockQueryFn as any);
  });

  afterEach(() => {
    _setQueryFn(undefined);
  });

  it("should analyze testing strategy", async () => {
    const result = await analyzeIntake(mockScan, mockValidation);

    expect(result.testingStrategy).toBeDefined();
    expect(result.testingStrategy.primaryCommand.command).toBe("npm run test:unit");
    expect(result.testingStrategy.primaryCommand.rationale).toContain("unit tests");
    expect(result.testingStrategy.targetedCommand).toBeDefined();
    expect(result.testingStrategy.fullSuiteCommand).toBeDefined();
    expect(result.testingStrategy.estimatedFullSuiteTime).toBe("~2 minutes");
    expect(result.testingStrategy.recommendations).toEqual(
      expect.arrayContaining([expect.stringContaining("targeted testing")]),
    );
  });

  it("should generate conventions analysis", async () => {
    const result = await analyzeIntake(mockScan, mockValidation);

    expect(result.conventionsAnalysis).toBeDefined();
    expect(typeof result.conventionsAnalysis).toBe("string");
  });

  it("should review adapter configuration", async () => {
    const result = await analyzeIntake(mockScan, mockValidation);

    expect(result.adapterReview).toBeDefined();
    expect(result.adapterReview.suggestions).toBeDefined();
    expect(Array.isArray(result.adapterReview.suggestions)).toBe(true);
    expect(result.adapterReview.confidence).toMatch(/^(high|medium|low)$/);
  });

  it("should handle LLM analysis in parallel", async () => {
    const startTime = Date.now();
    await analyzeIntake(mockScan, mockValidation);
    const duration = Date.now() - startTime;

    // Should complete reasonably fast (all 3 analyses run in parallel)
    expect(duration).toBeLessThan(5000);
  });

  it("should parse testing strategy from LLM response", async () => {
    const result = await analyzeIntake(mockScan, mockValidation);

    expect(result.testingStrategy.primaryCommand).toHaveProperty("command");
    expect(result.testingStrategy.primaryCommand).toHaveProperty("rationale");
  });
});
