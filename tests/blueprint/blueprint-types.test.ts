import type {
  Blueprint,
  FileAnalysis,
  CodeExample,
  VerificationPattern,
} from "../../src/blueprint/blueprint-types.js";

describe("blueprint-types", () => {
  describe("Blueprint interface", () => {
    it("should allow a valid blueprint with all fields", () => {
      const blueprint: Blueprint = {
        taskId: "TASK-001",
        fileAnalyses: [
          {
            filePath: "src/example.ts",
            action: "Modify",
            currentStructure: "exportClass Example at line 10",
            integrationPoints: "Add method to Example class",
            patternToFollow: "src/other.ts:25",
          },
        ],
        codeExamples: [
          {
            file: "src/example.ts",
            description: "Add new method",
            before: "export class Example {}",
            after: "export class Example { newMethod() {} }",
          },
        ],
        verificationPatterns: [
          {
            criterion: "Example class has newMethod",
            checkType: "grep",
            pattern: "newMethod",
            fileGlob: "src/example.ts",
          },
        ],
        antiPatterns: ["Do not stub methods"],
        preconditions: ["Existing tests must pass"],
      };

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toHaveLength(1);
      expect(blueprint.codeExamples).toHaveLength(1);
      expect(blueprint.verificationPatterns).toHaveLength(1);
      expect(blueprint.antiPatterns).toHaveLength(1);
      expect(blueprint.preconditions).toHaveLength(1);
    });

    it("should allow empty arrays for optional fields", () => {
      const blueprint: Blueprint = {
        taskId: "TASK-002",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      };

      expect(blueprint.fileAnalyses).toEqual([]);
      expect(blueprint.codeExamples).toEqual([]);
    });
  });

  describe("FileAnalysis interface", () => {
    it("should support Create action", () => {
      const analysis: FileAnalysis = {
        filePath: "src/new-file.ts",
        action: "Create",
        currentStructure: "[new file]",
        integrationPoints: "Import in src/index.ts",
        patternToFollow: "src/existing-file.ts:10",
      };

      expect(analysis.action).toBe("Create");
    });

    it("should support Modify action", () => {
      const analysis: FileAnalysis = {
        filePath: "src/existing.ts",
        action: "Modify",
        currentStructure: "export function foo() at line 5",
        integrationPoints: "Add parameter to foo()",
        patternToFollow: "src/bar.ts:15",
      };

      expect(analysis.action).toBe("Modify");
    });

    it("should support Delete action", () => {
      const analysis: FileAnalysis = {
        filePath: "src/deprecated.ts",
        action: "Delete",
        currentStructure: "export const DEPRECATED = true",
        integrationPoints: "Remove all imports",
        patternToFollow: "",
      };

      expect(analysis.action).toBe("Delete");
    });
  });

  describe("CodeExample interface", () => {
    it("should represent before/after code changes", () => {
      const example: CodeExample = {
        file: "src/config.ts",
        description: "Add new configuration option",
        before: "export const config = { port: 3000 };",
        after: "export const config = { port: 3000, timeout: 5000 };",
      };

      expect(example.file).toBe("src/config.ts");
      expect(example.before).toContain("port: 3000");
      expect(example.after).toContain("timeout: 5000");
    });

    it("should handle new file creation", () => {
      const example: CodeExample = {
        file: "src/new.ts",
        description: "Create new module",
        before: "[new file]",
        after: "export function newFunction() { return 42; }",
      };

      expect(example.before).toBe("[new file]");
    });
  });

  describe("VerificationPattern interface", () => {
    it("should support grep check type", () => {
      const pattern: VerificationPattern = {
        criterion: "Function exists",
        checkType: "grep",
        pattern: "export function myFunc",
        fileGlob: "src/**/*.ts",
      };

      expect(pattern.checkType).toBe("grep");
      expect(pattern.expectedMatches).toBeUndefined();
    });

    it("should support grep_count check type with expectedMatches", () => {
      const pattern: VerificationPattern = {
        criterion: "Three test cases added",
        checkType: "grep_count",
        pattern: "it\\(.*should",
        fileGlob: "tests/example.test.ts",
        expectedMatches: 3,
      };

      expect(pattern.checkType).toBe("grep_count");
      expect(pattern.expectedMatches).toBe(3);
    });

    it("should support file_exists check type", () => {
      const pattern: VerificationPattern = {
        criterion: "Config file created",
        checkType: "file_exists",
        pattern: "config/settings.json",
        fileGlob: "",
      };

      expect(pattern.checkType).toBe("file_exists");
    });

    it("should support file_not_exists check type", () => {
      const pattern: VerificationPattern = {
        criterion: "Deprecated file removed",
        checkType: "file_not_exists",
        pattern: "src/deprecated.ts",
        fileGlob: "",
      };

      expect(pattern.checkType).toBe("file_not_exists");
    });
  });
});
