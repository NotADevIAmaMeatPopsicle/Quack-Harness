import {
  evaluateComplexity,
  clusterCriteriaByFile,
  countIndependentClusters,
} from "../../src/preflight/complexity-evaluator";
import type { ParsedTask, ContextSizeEstimate, FileModification } from "../../src/core/types";
import type { ComplexityThresholds } from "../../src/preflight/preflight-types";
import { DEFAULT_COMPLEXITY_THRESHOLDS } from "../../src/preflight/preflight-types";

// ─── Helpers ──────────────────────────────────────────────────────

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "TASK-099",
    title: "Test task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
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
      { path: "src/a.ts", action: "Modify", notes: "" },
      { path: "src/b.ts", action: "Modify", notes: "" },
    ],
    successCriteria: ["criterion 1", "criterion 2"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-099",
    ...overrides,
  };
}

function makeContextEstimate(overrides: Partial<ContextSizeEstimate> = {}): ContextSizeEstimate {
  return {
    taskSpec: 1000,
    blueprint: 2000,
    repoMap: 1000,
    relevantFiles: 3000,
    relatedPatterns: 500,
    existingTests: 1500,
    conventions: 1000,
    claudeMd: 500,
    total: 10500,
    withinBudget: true,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("evaluateComplexity", () => {
  it("returns no decomposition for task within all thresholds", () => {
    const task = makeTask();
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    expect(result.recommendDecomposition).toBe(false);
    expect(result.filesToModify).toBe(2);
    expect(result.successCriteria).toBe(2);
    expect(result.estimatedContextTokens).toBe(10500);
    expect(result.reason).toContain("within acceptable thresholds");
  });

  it("recommends decomposition when files exceed threshold", () => {
    const task = makeTask({
      filesToModify: Array.from({ length: 8 }, (_, i) => ({
        path: `src/file${i}.ts`,
        action: "Modify" as const,
        notes: "",
      })),
    });
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    expect(result.recommendDecomposition).toBe(true);
    expect(result.filesToModify).toBe(8);
    expect(result.reason).toContain("8 files to modify exceeds limit of 6");
  });

  it("recommends decomposition when success criteria exceed threshold", () => {
    const task = makeTask({
      successCriteria: Array.from({ length: 12 }, (_, i) => `criterion ${i + 1}`),
    });
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    expect(result.recommendDecomposition).toBe(true);
    expect(result.successCriteria).toBe(12);
    expect(result.reason).toContain("12 success criteria exceeds limit of 8");
  });

  it("recommends decomposition when context tokens exceed threshold", () => {
    const task = makeTask();
    const estimate = makeContextEstimate({ total: 40000 });

    const result = evaluateComplexity(task, estimate);

    expect(result.recommendDecomposition).toBe(true);
    expect(result.estimatedContextTokens).toBe(40000);
    expect(result.reason).toContain("40000 estimated context tokens exceeds limit of 35000");
  });

  it("includes multiple reasons when multiple thresholds exceeded", () => {
    const task = makeTask({
      filesToModify: Array.from({ length: 10 }, (_, i) => ({
        path: `src/file${i}.ts`,
        action: "Modify" as const,
        notes: "",
      })),
      successCriteria: Array.from({ length: 15 }, (_, i) => `criterion ${i + 1}`),
    });
    const estimate = makeContextEstimate({ total: 50000 });

    const result = evaluateComplexity(task, estimate);

    expect(result.recommendDecomposition).toBe(true);
    expect(result.reason).toContain("10 files to modify");
    expect(result.reason).toContain("15 success criteria");
    expect(result.reason).toContain("50000 estimated context tokens");
  });

  it("respects custom thresholds", () => {
    const task = makeTask({
      filesToModify: [
        { path: "src/a.ts", action: "Modify", notes: "" },
        { path: "src/b.ts", action: "Modify", notes: "" },
        { path: "src/c.ts", action: "Modify", notes: "" },
      ],
    });
    const estimate = makeContextEstimate();
    const thresholds: ComplexityThresholds = {
      maxFilesBeforeDecompose: 2,
      maxCriteriaBeforeDecompose: 5,
      maxContextTokensBeforeDecompose: 20000,
      maxIndependentFeatures: 10,
    };

    const result = evaluateComplexity(task, estimate, thresholds);

    expect(result.recommendDecomposition).toBe(true);
    expect(result.reason).toContain("3 files to modify exceeds limit of 2");
  });

  it("uses default thresholds when none provided", () => {
    const task = makeTask();
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    // With defaults (6, 8, 35000, 3) and our small task, should not recommend
    expect(result.recommendDecomposition).toBe(false);
    expect(DEFAULT_COMPLEXITY_THRESHOLDS.maxFilesBeforeDecompose).toBe(6);
    expect(DEFAULT_COMPLEXITY_THRESHOLDS.maxCriteriaBeforeDecompose).toBe(8);
    expect(DEFAULT_COMPLEXITY_THRESHOLDS.maxContextTokensBeforeDecompose).toBe(35000);
    expect(DEFAULT_COMPLEXITY_THRESHOLDS.maxIndependentFeatures).toBe(3);
  });

  it("includes independentFeatures and featureClusters in result", () => {
    const task = makeTask();
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    expect(result.independentFeatures).toBeDefined();
    expect(result.featureClusters).toBeDefined();
    expect(Array.isArray(result.featureClusters)).toBe(true);
  });
});

// ─── Feature Clustering Tests ─────────────────────────────────────

describe("clusterCriteriaByFile", () => {
  it("creates single cluster for single-feature task", () => {
    const criteria = ["Update server endpoint", "Add server validation"];
    const files: FileModification[] = [{ path: "src/server.ts", action: "Modify", notes: "" }];

    const clusters = clusterCriteriaByFile(criteria, files);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).toBe("server.ts");
    expect(clusters[0].criteriaIndices).toEqual([0, 1]);
    expect(clusters[0].files).toEqual(["src/server.ts"]);
  });

  it("creates multiple clusters for multi-feature task", () => {
    const criteria = ["Update server endpoint", "Add client validation", "Update dashboard UI"];
    const files: FileModification[] = [
      { path: "src/server.ts", action: "Modify", notes: "" },
      { path: "src/client.ts", action: "Modify", notes: "" },
      { path: "src/monitor/public/index.html", action: "Modify", notes: "" },
    ];

    const clusters = clusterCriteriaByFile(criteria, files);

    expect(clusters.length).toBeGreaterThanOrEqual(2);
    // Server criterion should match server.ts
    const serverCluster = clusters.find((c) => c.files.includes("src/server.ts"));
    expect(serverCluster).toBeDefined();
    expect(serverCluster!.criteriaIndices).toContain(0);
  });

  it("creates single unmapped cluster for unmapped criteria", () => {
    const criteria = ["All tests pass", "npm run build succeeds", "No lint errors"];
    const files: FileModification[] = [{ path: "src/server.ts", action: "Modify", notes: "" }];

    const clusters = clusterCriteriaByFile(criteria, files);

    const unmappedCluster = clusters.find((c) => c.label === "unmapped");
    expect(unmappedCluster).toBeDefined();
    expect(unmappedCluster!.criteriaIndices.length).toBe(3);
    expect(unmappedCluster!.files).toEqual([]);
  });

  it("uses path-segment matching (not just basename)", () => {
    const criteria = ["Dashboard shows progress", "Monitor endpoint handles request"];
    const files: FileModification[] = [
      { path: "src/monitor/public/index.html", action: "Modify", notes: "" },
      { path: "src/monitor/server.ts", action: "Modify", notes: "" },
    ];

    const clusters = clusterCriteriaByFile(criteria, files);

    // Both criteria should match monitor files
    expect(clusters.length).toBeGreaterThan(0);
    const allIndices = clusters.flatMap((c) => c.criteriaIndices);
    expect(allIndices).toContain(0);
    expect(allIndices).toContain(1);
  });

  it("matches criterion to file via path segment", () => {
    const criteria = ["Update server endpoint"];
    const files: FileModification[] = [{ path: "src/server.ts", action: "Modify", notes: "" }];

    const clusters = clusterCriteriaByFile(criteria, files);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).toBe("server.ts");
    expect(clusters[0].criteriaIndices).toEqual([0]);
  });
});

describe("countIndependentClusters", () => {
  it("counts clusters with zero file overlap as independent", () => {
    const clusters = [
      { label: "server.ts", criteriaIndices: [0], files: ["src/server.ts"] },
      { label: "client.ts", criteriaIndices: [1], files: ["src/client.ts"] },
    ];

    const count = countIndependentClusters(clusters);

    expect(count).toBe(2);
  });

  it("does not count overlapping clusters as independent", () => {
    const clusters = [
      { label: "shared", criteriaIndices: [0, 1], files: ["src/shared.ts"] },
      { label: "server", criteriaIndices: [2], files: ["src/server.ts", "src/shared.ts"] },
    ];

    const count = countIndependentClusters(clusters);

    expect(count).toBe(0); // Both clusters overlap on shared.ts
  });

  it("counts unmapped cluster as 1 independent feature", () => {
    const clusters = [{ label: "unmapped", criteriaIndices: [0, 1, 2], files: [] }];

    const count = countIndependentClusters(clusters);

    expect(count).toBe(1);
  });

  it("handles mix of overlapping and independent clusters", () => {
    const clusters = [
      { label: "server.ts", criteriaIndices: [0], files: ["src/server.ts"] },
      { label: "client.ts", criteriaIndices: [1], files: ["src/client.ts"] },
      { label: "unmapped", criteriaIndices: [2, 3], files: [] },
    ];

    const count = countIndependentClusters(clusters);

    expect(count).toBe(3); // All independent
  });
});

describe("evaluateComplexity with independent features", () => {
  it("recommends decomposition when independent features exceed threshold", () => {
    const task = makeTask({
      filesToModify: [
        { path: "src/server.ts", action: "Modify", notes: "" },
        { path: "src/client.ts", action: "Modify", notes: "" },
        { path: "src/dashboard.ts", action: "Modify", notes: "" },
        { path: "src/utils.ts", action: "Modify", notes: "" },
      ],
      successCriteria: [
        "Update server endpoint",
        "Add client validation",
        "Dashboard shows panel",
        "Utility function added",
      ],
    });
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    // Assert the precondition: 4 files each matching one criterion → 4 independent features
    expect(result.independentFeatures).toBeGreaterThan(3);
    expect(result.recommendDecomposition).toBe(true);
    expect(result.reason).toContain("independent feature groups exceeds limit of 3");
  });

  it("does not trigger decomposition at threshold boundary", () => {
    const task = makeTask({
      filesToModify: [
        { path: "src/server.ts", action: "Modify", notes: "" },
        { path: "src/client.ts", action: "Modify", notes: "" },
        { path: "src/dashboard.ts", action: "Modify", notes: "" },
      ],
      successCriteria: ["Update server endpoint", "Add client validation", "Dashboard shows panel"],
    });
    const estimate = makeContextEstimate();

    const result = evaluateComplexity(task, estimate);

    // 3 independent features at threshold of 3 should NOT trigger
    expect(result.independentFeatures).toBeLessThanOrEqual(3);
    expect(result.reason).not.toContain("independent feature groups");
  });

  it("triggers decomposition with lowered criteria threshold (9 criteria triggers, 8 does not)", () => {
    // 9 criteria should trigger with default threshold of 8
    const taskOver = makeTask({
      successCriteria: Array.from({ length: 9 }, (_, i) => `criterion ${i + 1}`),
    });
    const estimate = makeContextEstimate();
    const resultOver = evaluateComplexity(taskOver, estimate);
    expect(resultOver.recommendDecomposition).toBe(true);
    expect(resultOver.reason).toContain("9 success criteria exceeds limit of 8");

    // 8 criteria should not trigger
    const taskAt = makeTask({
      successCriteria: Array.from({ length: 8 }, (_, i) => `criterion ${i + 1}`),
    });
    const resultAt = evaluateComplexity(taskAt, estimate);
    expect(resultAt.reason).not.toContain("success criteria exceeds");
  });
});
