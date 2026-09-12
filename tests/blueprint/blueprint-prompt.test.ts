import {
  buildBlueprintPrompt,
  formatBlueprintForPrompt,
} from "../../src/blueprint/blueprint-prompt.js";
import type { ParsedTask } from "../../src/core/types.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";

describe("blueprint-prompt", () => {
  const mockTask: ParsedTask = {
    id: "TASK-001",
    title: "Add feature X",
    priority: "P1-HIGH",
    effort: "2-4 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: ["typescript-conventions"],
    tags: [],
    problemStatement: "We need feature X",
    currentState: "Feature X does not exist",
    recommendedApproach: "Create feature X in src/feature-x.ts",
    filesToModify: [
      {
        path: "src/feature-x.ts",
        action: "Create",
        notes: "Main implementation",
      },
      {
        path: "src/index.ts",
        action: "Modify",
        notes: "Export the new feature",
      },
    ],
    successCriteria: ["Feature X is exported from src/index.ts", "Tests pass"],
    testingRequirements: ["Unit tests for feature X"],
    contextReferences: ["src/feature-y.ts"],
    rawContent: "# TASK-001\n\nAdd feature X\n\n...",
  };

  describe("buildBlueprintPrompt", () => {
    it("should include task specification in prompt", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("Task Specification");
      expect(prompt).toContain(mockTask.rawContent);
    });

    it("should include files to modify section", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("Files to Modify");
      expect(prompt).toContain("src/feature-x.ts");
      expect(prompt).toContain("Create");
      expect(prompt).toContain("src/index.ts");
      expect(prompt).toContain("Modify");
    });

    it("should include success criteria section", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("Success Criteria");
      expect(prompt).toContain("Feature X is exported");
      expect(prompt).toContain("Tests pass");
    });

    it("should include conventions doc when provided", () => {
      const conventionsDoc = "# TypeScript Conventions\n\nUse strict mode";
      const prompt = buildBlueprintPrompt(mockTask, conventionsDoc);

      expect(prompt).toContain("Project Conventions");
      expect(prompt).toContain("Use strict mode");
    });

    it("should include instructions for JSON output", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("output a valid JSON object");
      expect(prompt).toContain("Blueprint interface");
      expect(prompt).toContain("fileAnalyses");
      expect(prompt).toContain("codeExamples");
      expect(prompt).toContain("verificationPatterns");
    });

    it("should instruct agent to use Read tool for Modify actions", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("Read to load the current file");
      expect(prompt).toContain('action is "Modify"');
    });

    it("should fence typed directives to existing repo-local exports", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).toContain("Emit only repo-local export directives");
      expect(prompt).toContain("external package imports");
      expect(prompt).toContain("dependencies that are not installed yet");
      expect(prompt).toMatch(/symbols or files that will be created by\s+this task/);
      expect(prompt).toContain("npm script names");
      expect(prompt).toContain("package.json keys");
      expect(prompt).toContain("configuration or object keys");
      expect(prompt).toContain("environment variables");
      expect(prompt).toMatch(/An empty\s+directive array is correct/);
    });

    it("should handle task with no files to modify", () => {
      const taskNoFiles: ParsedTask = {
        ...mockTask,
        filesToModify: [],
      };

      const prompt = buildBlueprintPrompt(taskNoFiles, "");

      expect(prompt).toContain("Task Specification");
      // Should not crash
    });

    it("should include contract sources directive when task has frontend files", () => {
      const frontendTask: ParsedTask = {
        ...mockTask,
        filesToModify: [
          {
            path: "frontends/admin-portal/src/types/admin.types.ts",
            action: "Create",
            notes: "Admin type definitions",
          },
          {
            path: "src/services/admin.service.js",
            action: "Modify",
            notes: "Backend service",
          },
        ],
      };

      const prompt = buildBlueprintPrompt(frontendTask, "");

      expect(prompt).toContain("Contract Sources Directive");
      expect(prompt).toContain("Model file");
      expect(prompt).toContain("DTO file");
      expect(prompt).toContain("Route file");
      expect(prompt).toContain("CRITICAL");
    });

    it("should NOT include contract sources directive for backend-only tasks", () => {
      const prompt = buildBlueprintPrompt(mockTask, "");

      expect(prompt).not.toContain("Contract Sources Directive");
    });

    it("should detect .tsx files as frontend", () => {
      const tsxTask: ParsedTask = {
        ...mockTask,
        filesToModify: [
          {
            path: "src/components/FlagDetail.tsx",
            action: "Create",
            notes: "Flag detail component",
          },
        ],
      };

      const prompt = buildBlueprintPrompt(tsxTask, "");

      expect(prompt).toContain("Contract Sources Directive");
    });
  });

  describe("formatBlueprintForPrompt", () => {
    const mockBlueprint: Blueprint = {
      taskId: "TASK-001",
      fileAnalyses: [
        {
          filePath: "src/feature-x.ts",
          action: "Create",
          currentStructure: "[new file]",
          integrationPoints: "Import in src/index.ts",
          patternToFollow: "src/feature-y.ts:10",
        },
      ],
      codeExamples: [
        {
          file: "src/index.ts",
          description: "Export feature X",
          before: "export { featureY } from './feature-y';",
          after: "export { featureY } from './feature-y';\nexport { featureX } from './feature-x';",
        },
      ],
      verificationPatterns: [
        {
          criterion: "Feature X is exported",
          checkType: "grep",
          pattern: "export.*featureX",
          fileGlob: "src/index.ts",
        },
      ],
      antiPatterns: ["Do not stub implementations"],
      preconditions: ["Existing tests must pass"],
    };

    it("should format blueprint with all sections", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("## Implementation Blueprint");
      expect(formatted).toContain("### File Analyses");
      expect(formatted).toContain("### Code Examples");
      expect(formatted).toContain("### Verification Patterns");
      expect(formatted).toContain("### Anti-Patterns");
      expect(formatted).toContain("### Preconditions");
    });

    it("should format file analyses with structure, integration points, and patterns", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("#### src/feature-x.ts (Create)");
      expect(formatted).toContain("**Current Structure:** [new file]");
      expect(formatted).toContain("**Integration Points:** Import in src/index.ts");
      expect(formatted).toContain("**Pattern to Follow:** src/feature-y.ts:10");
    });

    it("should format code examples with before/after", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("#### src/index.ts — Export feature X");
      expect(formatted).toContain("```typescript");
      expect(formatted).toContain("// BEFORE:");
      expect(formatted).toContain("// AFTER:");
      expect(formatted).toContain("export { featureX }");
    });

    it("should format verification patterns as a table", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("| Criterion | Check | Pattern | File | Expected |");
      expect(formatted).toContain(
        "| Feature X is exported | grep | `export.*featureX` | src/index.ts | - |",
      );
    });

    it("should format anti-patterns as list", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("- Do not stub implementations");
    });

    it("should format preconditions as list", () => {
      const formatted = formatBlueprintForPrompt(mockBlueprint);

      expect(formatted).toContain("- Existing tests must pass");
    });

    it("should handle empty blueprint gracefully", () => {
      const emptyBlueprint: Blueprint = {
        taskId: "TASK-002",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(emptyBlueprint);

      expect(formatted).toContain("## Implementation Blueprint");
      // Should not crash
    });

    it("should handle verification pattern with expectedMatches", () => {
      const blueprintWithCounts: Blueprint = {
        ...mockBlueprint,
        verificationPatterns: [
          {
            criterion: "Three tests added",
            checkType: "grep_count",
            pattern: "it\\(",
            fileGlob: "tests/*.test.ts",
            expectedMatches: 3,
          },
          {
            criterion: "No ambient randomness",
            checkType: "grep_count",
            pattern: "Math\\.random",
            fileGlob: "src/*.ts",
            expectedMatches: 0,
          },
        ],
      };

      const formatted = formatBlueprintForPrompt(blueprintWithCounts);

      expect(formatted).toContain(
        "| Three tests added | grep_count | `it\\(` | tests/*.test.ts | 3+ |",
      );
      expect(formatted).toContain(
        "| No ambient randomness | grep_count | `Math\\.random` | src/*.ts | exactly 0 |",
      );
    });
  });

  describe("formatBlueprintForPrompt — size caps", () => {
    it("should truncate code example before/after at 50 lines", () => {
      const longSnippet = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
      const blueprint: Blueprint = {
        taskId: "TASK-CAP",
        fileAnalyses: [],
        codeExamples: [
          {
            file: "src/big.ts",
            description: "Long snippet",
            before: longSnippet,
            after: longSnippet,
          },
        ],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      // Should contain truncation note (80 - 50 = 30 more lines)
      expect(formatted).toContain("[truncated — 30 more lines]");
      // The note should appear twice (once for before, once for after)
      const matches = formatted.match(/\[truncated — 30 more lines\]/g);
      expect(matches).toHaveLength(2);
      // Should NOT contain line 80
      expect(formatted).not.toContain("line 80");
      // Should contain line 50
      expect(formatted).toContain("line 50");
    });

    it("should not truncate snippets under 50 lines", () => {
      const shortSnippet = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      const blueprint: Blueprint = {
        taskId: "TASK-SHORT",
        fileAnalyses: [],
        codeExamples: [
          {
            file: "src/small.ts",
            description: "Short snippet",
            before: shortSnippet,
            after: shortSnippet,
          },
        ],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      expect(formatted).not.toContain("[truncated");
      expect(formatted).toContain("line 10");
    });

    it("should cap total code examples at 8", () => {
      const examples = Array.from({ length: 12 }, (_, i) => ({
        file: `src/file-${i}.ts`,
        description: `Example ${i}`,
        before: `before ${i}`,
        after: `after ${i}`,
      }));

      const blueprint: Blueprint = {
        taskId: "TASK-MANY-EX",
        fileAnalyses: [],
        codeExamples: examples,
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      // Should include first 8 examples
      expect(formatted).toContain("src/file-0.ts");
      expect(formatted).toContain("src/file-7.ts");
      // Should NOT include example 9+
      expect(formatted).not.toContain("src/file-8.ts");
      // Should show truncation note
      expect(formatted).toContain("8 of 12 examples shown");
      expect(formatted).toContain("4 omitted");
    });

    it("should cap anti-patterns at 15", () => {
      const antiPatterns = Array.from({ length: 20 }, (_, i) => `Do NOT do thing ${i}`);

      const blueprint: Blueprint = {
        taskId: "TASK-MANY-AP",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns,
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      // Should include first 15
      expect(formatted).toContain("Do NOT do thing 0");
      expect(formatted).toContain("Do NOT do thing 14");
      // Should NOT include #15+
      expect(formatted).not.toContain("Do NOT do thing 15");
      // Should show truncation note
      expect(formatted).toContain("15 of 20 anti-patterns shown");
      expect(formatted).toContain("5 omitted");
    });

    it("should cap verification patterns at 20", () => {
      const patterns = Array.from({ length: 25 }, (_, i) => ({
        criterion: `Criterion ${i}`,
        checkType: "grep" as const,
        pattern: `pattern-${i}`,
        fileGlob: `src/file-${i}.ts`,
      }));

      const blueprint: Blueprint = {
        taskId: "TASK-MANY-VP",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: patterns,
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      // Should include first 20
      expect(formatted).toContain("Criterion 0");
      expect(formatted).toContain("Criterion 19");
      // Should NOT include #20+
      expect(formatted).not.toContain("pattern-20");
      // Should show truncation note
      expect(formatted).toContain("20 of 25 patterns shown");
      expect(formatted).toContain("5 omitted");
    });

    it("should enforce total blueprint size cap (~8K tokens)", () => {
      // Create a blueprint large enough to exceed 32K chars
      const hugeSnippet = Array.from(
        { length: 50 },
        (_, i) => `// line ${i}: ${"x".repeat(200)}`,
      ).join("\n");
      const examples = Array.from({ length: 8 }, (_, i) => ({
        file: `src/huge-${i}.ts`,
        description: `Huge example ${i}`,
        before: hugeSnippet,
        after: hugeSnippet,
      }));

      const blueprint: Blueprint = {
        taskId: "TASK-HUGE",
        fileAnalyses: Array.from({ length: 10 }, (_, i) => ({
          filePath: `src/analysis-${i}.ts`,
          action: "Modify" as const,
          currentStructure: "x".repeat(500),
          integrationPoints: "y".repeat(500),
          patternToFollow: "z".repeat(500),
        })),
        codeExamples: examples,
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      const formatted = formatBlueprintForPrompt(blueprint);

      // Should be within budget (32K chars + some margin for the truncation note)
      // The function may produce slightly over due to the hard truncation note
      expect(formatted.length).toBeLessThanOrEqual(32_000 + 200);
    });

    it("should not modify small blueprints", () => {
      const smallBlueprint: Blueprint = {
        taskId: "TASK-SMALL",
        fileAnalyses: [
          {
            filePath: "src/small.ts",
            action: "Modify",
            currentStructure: "export function foo()",
            integrationPoints: "Called from main.ts",
            patternToFollow: "src/bar.ts:5",
          },
        ],
        codeExamples: [
          {
            file: "src/small.ts",
            description: "Add new function",
            before: "// existing code",
            after: "// existing code\nexport function newFn() {}",
          },
        ],
        verificationPatterns: [
          {
            criterion: "newFn is exported",
            checkType: "grep",
            pattern: "export function newFn",
            fileGlob: "src/small.ts",
          },
        ],
        antiPatterns: ["Do not stub"],
        preconditions: ["Tests must pass"],
      };

      const formatted = formatBlueprintForPrompt(smallBlueprint);

      // No truncation notes should appear
      expect(formatted).not.toContain("[truncated");
      expect(formatted).not.toContain("omitted");
      // All content should be present
      expect(formatted).toContain("src/small.ts");
      expect(formatted).toContain("export function newFn");
      expect(formatted).toContain("Do not stub");
      expect(formatted).toContain("Tests must pass");
    });
  });
});
