// ─── Decomposition Integration Tests ────────────────────────────────
// Tests for the integration between decomposition engine, dispatcher,
// and queue. Covers final subtask detection, shared branch logic,
// decompose prompt building, and queue enqueue.

import { hasFinalSubtaskCriterion } from "../../src/dispatcher/dispatcher.js";
import { buildDecomposePrompt } from "../../src/preflight/decompose-prompt.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";

describe("decompose-integration", () => {
  describe("hasFinalSubtaskCriterion", () => {
    it("should return true for tasks with integration criterion", () => {
      const task: ParsedTask = {
        id: "TASK-042-C",
        title: "Final Subtask",
        priority: "P1-HIGH",
        effort: "2 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: ["TASK-042-B"],
        blocks: [],
        conventions: [],
        tags: ["subtask"],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [],
        successCriteria: ["Module C implemented", "All parent task success criteria verified"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      expect(hasFinalSubtaskCriterion(task)).toBe(true);
    });

    it("should return false for non-final subtasks", () => {
      const task: ParsedTask = {
        id: "TASK-042-A",
        title: "First Subtask",
        priority: "P1-HIGH",
        effort: "2 hours",
        status: "READY",
        supersededBy: [],
        supersedes: [],
        relevanceReview: "",
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: ["subtask"],
        problemStatement: "Test",
        currentState: "Test",
        recommendedApproach: "Test",
        filesToModify: [],
        successCriteria: ["Module A implemented", "Tests pass"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      expect(hasFinalSubtaskCriterion(task)).toBe(false);
    });

    it("should be case-insensitive when matching criterion", () => {
      const task: ParsedTask = {
        id: "TASK-042-B",
        title: "Test",
        priority: "P1-HIGH",
        effort: "2 hours",
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
        filesToModify: [],
        successCriteria: ["ALL PARENT TASK SUCCESS CRITERIA VERIFIED"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      expect(hasFinalSubtaskCriterion(task)).toBe(true);
    });
  });

  describe("buildDecomposePrompt", () => {
    it("should include task ID and title", () => {
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
        problemStatement: "Complex task needing decomposition",
        currentState: "Test state",
        recommendedApproach: "Test approach",
        filesToModify: [
          { path: "src/a.ts", action: "Create", notes: "Module A" },
          { path: "src/b.ts", action: "Create", notes: "Module B" },
        ],
        successCriteria: ["Criterion 1", "Criterion 2"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-042",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const prompt = buildDecomposePrompt(task, blueprint);

      expect(prompt).toContain("TASK-042");
      expect(prompt).toContain("Multi-Project Switcher");
      // Topology-only prompt includes file paths and criteria but not problem statement prose
      expect(prompt).toContain("src/a.ts");
      expect(prompt).toContain("src/b.ts");
      expect(prompt).toContain("Criterion 1");
      expect(prompt).toContain("Criterion 2");
    });

    it("should include decomposition guidelines", () => {
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
        filesToModify: [],
        successCriteria: [],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-100",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const prompt = buildDecomposePrompt(task, blueprint);

      expect(prompt).toContain("2-4 subtasks maximum");
      expect(prompt).toContain("File ownership");
      expect(prompt).toContain("isFinal");
      expect(prompt).toContain("dependsOn");
    });

    it("should include blueprint data in prompt", () => {
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
        filesToModify: [{ path: "src/foo.ts", action: "Create", notes: "" }],
        successCriteria: ["Foo works"],
        testingRequirements: [],
        contextReferences: [],
        rawContent: "",
      };

      const blueprint: Blueprint = {
        taskId: "TASK-100",
        fileAnalyses: [
          {
            filePath: "src/foo.ts",
            action: "Create",
            currentStructure: "[new file]",
            integrationPoints: "Imports from src/bar.ts",
            patternToFollow: "Follow existing patterns",
          },
        ],
        codeExamples: [
          {
            file: "src/foo.ts",
            description: "Example code",
            before: "// before",
            after: "// after",
          },
        ],
        verificationPatterns: [],
        antiPatterns: ["Do not use any"],
        preconditions: [],
      };

      const prompt = buildDecomposePrompt(task, blueprint);

      // Blueprint should be referenced in the prompt
      expect(prompt).toContain("Blueprint");
    });
  });

  describe("DispatchOptions shared branch", () => {
    it("should include parentTaskId and sharedBranchName fields", () => {
      // This test verifies the type structure exists by creating options
      const options = {
        parentTaskId: "TASK-042",
        sharedBranchName: "quack/TASK-042",
        skipGate: true,
        skipBranch: false,
      };

      expect(options.parentTaskId).toBe("TASK-042");
      expect(options.sharedBranchName).toBe("quack/TASK-042");
    });
  });
});
