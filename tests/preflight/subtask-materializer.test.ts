// ─── Subtask Materializer Tests ─────────────────────────────────────
// Tests for materializeChildDrafts and buildFallbackChildDraft.

import {
  materializeChildDrafts,
  buildFallbackChildDraft,
  _setQueryFn,
} from "../../src/preflight/subtask-materializer.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { DecompositionTopology } from "../../src/preflight/decompose-types.js";

// ─── Fixtures ───────────────────────────────────────────────────────

const baseTask: ParsedTask = {
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
  tags: ["feature"],
  problemStatement: "The system lacks multi-project support. Users cannot switch between projects.",
  currentState: "Single-project only. No registry, no switcher, no API.",
  recommendedApproach: "Implement a project registry, a switcher component, and REST endpoints.",
  filesToModify: [
    { path: "src/registry.ts", action: "Create", notes: "Project registry module" },
    { path: "src/api.ts", action: "Create", notes: "REST endpoints" },
  ],
  successCriteria: ["Registry works", "API endpoints return valid JSON"],
  testingRequirements: [],
  contextReferences: ["docs/ARCHITECTURE.md"],
  rawContent: "",
};

const baseBlueprint: Blueprint = {
  taskId: "TASK-042",
  fileAnalyses: [
    {
      filePath: "src/registry.ts",
      action: "Create",
      currentStructure: "[new file]",
      integrationPoints: "None",
      patternToFollow: "Use Map<string, Project>",
    },
    {
      filePath: "src/api.ts",
      action: "Create",
      currentStructure: "[new file]",
      integrationPoints: "Imports from src/registry.ts",
      patternToFollow: "Express 4 routes",
    },
  ],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
  preconditions: [],
};

function makeAdapter(): ProjectAdapter {
  return {
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
      costVelocity: { enabled: false, alertThreshold: 2.0, killThreshold: 5.0, windowMinutes: 15 },
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
}

/** Build a topology with two subtasks for standard tests */
function makeTwoSubtaskTopology(): DecompositionTopology {
  return {
    parentTaskId: "TASK-042",
    subtasks: [
      {
        id: "TASK-042-A",
        title: "Implement Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-042-B",
        title: "Implement API",
        filesToModify: [{ path: "src/api.ts", action: "Create" as const, notes: "" }],
        successCriteria: [
          "API endpoints return valid JSON",
          "All parent task success criteria verified",
        ],
        dependsOn: ["TASK-042-A"],
        isFinal: true,
      },
    ],
    coverageReport: {
      fileOwnership: [
        { filePath: "src/registry.ts", ownedBy: "TASK-042-A", isShared: false },
        { filePath: "src/api.ts", ownedBy: "TASK-042-B", isShared: false },
      ],
      criterionOwnership: [
        { criterion: "Registry works", ownedBy: ["TASK-042-A"] },
        { criterion: "API endpoints return valid JSON", ownedBy: ["TASK-042-B"] },
      ],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      hasCoverageGap: false,
    },
  };
}

/** Build a valid rich markdown that will pass the quality gate */
function buildRichMarkdown(subtaskId: string, title: string): string {
  const isFinal = subtaskId.endsWith("-B");
  const filePath = isFinal ? "src/api.ts" : "src/registry.ts";
  const criterion = isFinal ? "API endpoints return valid JSON" : "Registry works";
  const blockedBy = isFinal ? "[TASK-042-A]" : "[]";
  return `# ${subtaskId}: ${title}

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2-3 hours
- **Status:** READY
- **Blocked By:** ${blockedBy}
- **Blocks:** []
- **Tags:** feature, subtask

## Problem Statement
This child task implements the ${title} component within the multi-project system. It is responsible for establishing the data layer that sibling subtasks will build upon. Without this child completing successfully, downstream components cannot proceed.

## Current State
The ${filePath} file does not exist yet. The owned module must be created from scratch following the pattern described in the blueprint. No existing code needs migration.

## Recommended Approach
Create ${filePath} with the exact behavior assigned by the topology. Follow the existing pattern from src/core/types.ts, preserve the dependency boundary, and add input validation for public functions.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| \`${filePath}\` | Create | Owned project module |

## Success Criteria
- [ ] ${criterion}
${isFinal ? "- [ ] All parent task success criteria verified" : ""}

## Testing Requirements
- [ ] Unit test: addProject stores a project and getProject retrieves it by ID
- [ ] Unit test: removeProject removes the project and getProject returns undefined after
- [ ] Unit test: addProject with duplicate ID throws or overwrites deterministically
- [ ] Integration test: registry integrates with the API layer without type errors

## Anti-Patterns
- Do NOT use a plain object as the registry backing store — use Map for O(1) lookup
- Do NOT expose internal Map directly — always return defensive copies
- Do NOT allow callers to mutate Project objects returned from getProject

## Context References
- Parent task: TASK-042
- docs/ARCHITECTURE.md
`;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("subtask-materializer", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  describe("materializeChildDrafts", () => {
    it("should return one draft per subtask in the topology", async () => {
      const topology = makeTwoSubtaskTopology();
      const adapter = makeAdapter();

      // Mock LLM: return rich markdown for each subtask
      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQueryFn = async function* (params: { prompt: string }) {
        // Determine which subtask this is from the prompt
        const isA = params.prompt.includes("**ID:** TASK-042-A\n");
        const subtaskId = isA ? "TASK-042-A" : "TASK-042-B";
        const title = isA ? "Implement Registry" : "Implement API";

        yield {
          type: "result",
          subtype: "success",
          result: buildRichMarkdown(subtaskId, title),
        };
      };

      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const drafts = await materializeChildDrafts(topology, baseTask, adapter, baseBlueprint);

      expect(drafts).toHaveLength(2);
      expect(drafts[0].subtaskId).toBe("TASK-042-A");
      expect(drafts[1].subtaskId).toBe("TASK-042-B");
    });

    it("should run quality gate on each draft and populate prepScore", async () => {
      const topology = makeTwoSubtaskTopology();
      const adapter = makeAdapter();

      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQueryFn = async function* (params: { prompt: string }) {
        const isA = params.prompt.includes("**ID:** TASK-042-A\n");
        yield {
          type: "result",
          subtype: "success",
          result: buildRichMarkdown(
            isA ? "TASK-042-A" : "TASK-042-B",
            isA ? "Implement Registry" : "Implement API",
          ),
        };
      };

      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const drafts = await materializeChildDrafts(topology, baseTask, adapter, baseBlueprint);

      for (const draft of drafts) {
        expect(typeof draft.prepScore).toBe("number");
        expect(draft.prepScore).toBeGreaterThanOrEqual(0);
        expect(draft.prepScore).toBeLessThanOrEqual(5);
        expect(Array.isArray(draft.sectionsPresent)).toBe(true);
        expect(Array.isArray(draft.deficiencies)).toBe(true);
      }
    });

    it("should return prepReady=true for high-quality drafts", async () => {
      const topology = makeTwoSubtaskTopology();

      // eslint-disable-next-line @typescript-eslint/require-await
      const mockQueryFn = async function* (params: { prompt: string }) {
        const isA = params.prompt.includes("**ID:** TASK-042-A\n");
        yield {
          type: "result",
          subtype: "success",
          result: buildRichMarkdown(
            isA ? "TASK-042-A" : "TASK-042-B",
            isA ? "Implement Registry" : "Implement API",
          ),
        };
      };

      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const adapter = makeAdapter();
      const drafts = await materializeChildDrafts(topology, baseTask, adapter, baseBlueprint);

      expect(drafts).toHaveLength(2);
      expect(
        drafts.map((draft) => ({
          subtaskId: draft.subtaskId,
          prepReady: draft.prepReady,
          prepScore: draft.prepScore,
          deficiencies: draft.deficiencies,
        })),
      ).toEqual([
        expect.objectContaining({ prepReady: true, prepScore: 5, deficiencies: [] }),
        expect.objectContaining({ prepReady: true, prepScore: 5, deficiencies: [] }),
      ]);
    });

    it("should produce a parse-error draft when LLM call throws", async () => {
      const topology = makeTwoSubtaskTopology();
      const adapter = makeAdapter();

      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      const mockQueryFn = async function* (): AsyncGenerator<never> {
        throw new Error("LLM call failed: rate limit");
      };

      _setQueryFn(mockQueryFn as unknown as Parameters<typeof _setQueryFn>[0]);

      const drafts = await materializeChildDrafts(topology, baseTask, adapter, baseBlueprint);

      // Should return drafts for all subtasks, not throw
      expect(drafts).toHaveLength(2);

      // The errored drafts should have prepReady=false and a parseError
      for (const draft of drafts) {
        expect(draft.prepReady).toBe(false);
        expect(draft.prepScore).toBe(0);
        expect(draft.parseError).toBeDefined();
        expect(draft.deficiencies.some((d) => d.includes("Materialization failed"))).toBe(true);
      }
    });

    it("should reject an empty subtask list", async () => {
      const topology: DecompositionTopology = {
        parentTaskId: "TASK-042",
        subtasks: [],
        coverageReport: {
          fileOwnership: [],
          criterionOwnership: [],
          unmappedFiles: [],
          unmappedCriteria: [],
          duplicatedFiles: [],
          hasCoverageGap: false,
        },
      };

      const adapter = makeAdapter();
      await expect(
        materializeChildDrafts(topology, baseTask, adapter, baseBlueprint),
      ).rejects.toThrow(/must contain 2\.\.configuredMax/i);
    });
  });

  describe("buildFallbackChildDraft", () => {
    it("should return a non-empty markdown string", () => {
      const subtask = {
        id: "TASK-042-A",
        title: "Implement Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      expect(typeof markdown).toBe("string");
      expect(markdown.length).toBeGreaterThan(100);
    });

    it("should include the subtask ID and title in the fallback", () => {
      const subtask = {
        id: "TASK-042-A",
        title: "Implement The Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      expect(markdown).toContain("TASK-042-A");
      expect(markdown).toContain("Implement The Registry");
    });

    it("should include Full-Stack Completion Addendum for cross-layer files", () => {
      const subtask = {
        id: "TASK-042-B",
        title: "Update Server Routes",
        filesToModify: [
          { path: "src/monitor/server.ts", action: "Modify" as const, notes: "Add route" },
        ],
        successCriteria: ["Route added"],
        dependsOn: ["TASK-042-A"],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      expect(markdown).toContain("Full-Stack Completion Addendum");
    });

    it("should NOT include Full-Stack Completion Addendum for pure library files", () => {
      const subtask = {
        id: "TASK-042-A",
        title: "Implement Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      expect(markdown).not.toContain("Full-Stack Completion Addendum");
    });

    it("should NOT contain banned stub patterns", () => {
      const subtask = {
        id: "TASK-042-A",
        title: "Implement Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      expect(markdown).not.toMatch(/This subtask is part of TASK-\w+ decomposition/i);
      expect(markdown).not.toMatch(/At least \d+×2 new tests/i);
      expect(markdown).not.toMatch(/Follow the implementation patterns from the parent task/i);
      expect(markdown).not.toMatch(/Parent task TASK-\w+ was decomposed into multiple subtasks/i);
    });

    it("should include parent contextReferences in fallback", () => {
      const subtask = {
        id: "TASK-042-A",
        title: "Implement Registry",
        filesToModify: [{ path: "src/registry.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["Registry works"],
        dependsOn: [],
        isFinal: false,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      // baseTask has contextReferences: ["docs/ARCHITECTURE.md"]
      expect(markdown).toContain("docs/ARCHITECTURE.md");
    });

    it("should add final verification language for isFinal=true subtasks", () => {
      const subtask = {
        id: "TASK-042-B",
        title: "Final Integration",
        filesToModify: [{ path: "src/api.ts", action: "Create" as const, notes: "" }],
        successCriteria: ["All parent task success criteria verified"],
        dependsOn: ["TASK-042-A"],
        isFinal: true,
      };

      const markdown = buildFallbackChildDraft(subtask, baseTask);

      // Final subtask should mention end-to-end verification
      expect(markdown).toContain("All parent task success criteria verified");
    });
  });
});
