import {
  generateBlueprint,
  _setQueryFn,
  extractBlueprintJson,
} from "../../src/blueprint/blueprint-agent.js";
import type { AdapterConfig, ParsedTask } from "../../src/core/types.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { Blueprint } from "../../src/blueprint/blueprint-types.js";

describe("blueprint-agent", () => {
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
    ],
    successCriteria: ["Feature X is exported"],
    testingRequirements: ["Unit tests for feature X"],
    contextReferences: [],
    rawContent: "# TASK-001\n\nAdd feature X",
  };

  const config: AdapterConfig = {
    version: "1.0.0",
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
      maxTurns: 30,
      maxBudgetPerTask: 5.0,
      maxRetries: 2,
    },
    verification: {
      commands: [],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "info",
      retainDays: 30,
    },
  };

  const mockAdapter: ProjectAdapter = {
    projectRoot: "/test/project",
    config,
    conventionsDoc: "# TypeScript Conventions\n\nUse strict mode",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };

  afterEach(() => {
    _setQueryFn(undefined);
  });

  describe("generateBlueprint", () => {
    it("should return a valid Blueprint object on success", async () => {
      const mockBlueprintJson: Blueprint = {
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
            before: "export { featureY }",
            after: "export { featureY, featureX }",
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

      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify(mockBlueprintJson),
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toHaveLength(1);
      expect(blueprint.fileAnalyses[0].filePath).toBe("src/feature-x.ts");
      expect(blueprint.codeExamples).toHaveLength(1);
      expect(blueprint.verificationPatterns).toHaveLength(1);
      expect(blueprint.antiPatterns).toHaveLength(1);
      expect(blueprint.preconditions).toHaveLength(1);
      expect(blueprint.producerProvenance).toEqual({
        runner: "claude-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("audits mandate fidelity against the authoritative task, not the model echo", async () => {
      const mandate = "`npm test -- --runInBand` expect: exactly-0";
      const softened = "`npm test -- --runInBand` expect: 0+";
      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [
              {
                filePath: "src/feature-x.ts",
                action: "Create",
                currentStructure: "[new file]",
                integrationPoints: "new module",
                patternToFollow: "none",
              },
            ],
            codeExamples: [],
            verificationPatterns: [
              {
                criterion: "Exact-zero verification",
                checkType: "grep",
                pattern: "npm test",
                fileGlob: "package.json",
                mandatedCheck: softened,
              },
            ],
            antiPatterns: [],
            preconditions: [],
            mandatedChecks: [softened],
          }),
        };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(
        { ...mockTask, mandatedChecks: [mandate] },
        mockAdapter,
      );

      expect(blueprint.fidelity?.status).toBe("failed");
      expect(blueprint.fidelity?.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "mandated_check_softened" })]),
      );
    });

    it("should fall back to minimal blueprint on JSON parse error", async () => {
      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: "invalid JSON {{{",
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toEqual([]);
      expect(blueprint.codeExamples).toEqual([]);
      expect(blueprint.verificationPatterns).toEqual([]);
    });

    it("should fall back to minimal blueprint if required fields are missing", async () => {
      const invalidBlueprint = {
        // Missing taskId
        fileAnalyses: "not an array",
      };

      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify(invalidBlueprint),
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toEqual([]);
    });

    it("should fall back to minimal blueprint on SDK error", async () => {
      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "error",
          errors: ["SDK error occurred"],
          total_cost_usd: 0.05,
          num_turns: 5,
          stop_reason: "error",
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toEqual([]);
    });

    it("should fall back to minimal blueprint if no result received", async () => {
      // eslint-disable-next-line require-yield
      const mockQueryFn = async function* () {
        await Promise.resolve();
        // Yield no messages
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toEqual([]);
    });

    it("should use adapter enrichModel by default", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(mockTask, mockAdapter);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: expect.objectContaining({
            model: "claude-sonnet-4-6",
          }),
        }),
      );
    });

    it("should respect model override option", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(mockTask, mockAdapter, { model: "claude-opus-4-20250514" });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: expect.objectContaining({
            model: "claude-opus-4-20250514",
          }),
        }),
      );
    });

    it("should respect maxTurns override option", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(mockTask, mockAdapter, { maxTurns: 10 });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: expect.objectContaining({
            maxTurns: 10,
          }),
        }),
      );
    });

    it("should use Read, Glob, Grep tools only", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(mockTask, mockAdapter);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: expect.objectContaining({
            allowedTools: ["Read", "Glob", "Grep"],
            disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
          }),
        }),
      );
    });

    it("should use cwd from adapter.projectRoot", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(mockTask, mockAdapter);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          options: expect.objectContaining({
            cwd: "/test/project",
          }),
        }),
      );
    });

    it("should extract blueprint from prose with code fence (real failure mode)", async () => {
      const proseWithJson = `Perfect! Now I've analyzed all the files. Here's the implementation blueprint:

\`\`\`json
${JSON.stringify({
  taskId: "TASK-001",
  fileAnalyses: [
    {
      filePath: "src/test.ts",
      action: "Create",
      currentStructure: "",
      integrationPoints: "wire into index.ts",
      patternToFollow: "",
    },
  ],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: ["Do not stub"],
  preconditions: [],
})}
\`\`\`

This blueprint covers the key integration points.`;

      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: proseWithJson,
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toHaveLength(1);
      expect(blueprint.antiPatterns).toEqual(["Do not stub"]);
    });

    it("should extract blueprint from inline JSON surrounded by prose", async () => {
      const proseWithInlineJson = `After analyzing the codebase, here is the blueprint:

{"taskId":"TASK-001","fileAnalyses":[{"filePath":"src/x.ts","action":"Create","currentStructure":"","integrationPoints":"","patternToFollow":""}],"codeExamples":[],"verificationPatterns":[],"antiPatterns":[],"preconditions":[]}

I hope this helps the coding agent.`;

      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: proseWithInlineJson,
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.taskId).toBe("TASK-001");
      expect(blueprint.fileAnalyses).toHaveLength(1);
    });

    it("should normalize missing array fields to empty arrays", async () => {
      const partialBlueprint = {
        taskId: "TASK-001",
        fileAnalyses: [
          {
            filePath: "src/test.ts",
            action: "Create",
            currentStructure: "",
            integrationPoints: "",
            patternToFollow: "",
          },
        ],
        // Missing codeExamples, verificationPatterns, antiPatterns, preconditions
      };

      const mockQueryFn = async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify(partialBlueprint),
        };
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      const blueprint = await generateBlueprint(mockTask, mockAdapter);

      expect(blueprint.fileAnalyses).toHaveLength(1);
      expect(blueprint.codeExamples).toEqual([]);
      expect(blueprint.verificationPatterns).toEqual([]);
      expect(blueprint.antiPatterns).toEqual([]);
      expect(blueprint.preconditions).toEqual([]);
    });
  });

  describe("contract sources directive", () => {
    it("should include Contract Sources Directive in prompt for frontend tasks", async () => {
      const frontendTask: ParsedTask = {
        ...mockTask,
        filesToModify: [
          {
            path: "frontends/admin/moderation/types.ts",
            action: "Create",
            notes: "Frontend types for moderation",
          },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [
              {
                filePath: "frontends/admin/moderation/types.ts",
                action: "Create",
                currentStructure: "[new file]",
                integrationPoints: "Contract Sources: src/src/models/moderation-flag.model.js",
                patternToFollow: "",
              },
            ],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(frontendTask, mockAdapter);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const promptArg: string = (mockQueryFn as jest.Mock).mock.calls[0][0].prompt;
      expect(promptArg).toContain("Contract Sources Directive");
      expect(promptArg).toContain("Model file");
      expect(promptArg).toContain("DTO file");
      expect(promptArg).toContain("Route file");
    });

    it("should NOT include Contract Sources Directive for backend-only tasks", async () => {
      const backendTask: ParsedTask = {
        ...mockTask,
        filesToModify: [
          {
            path: "src/services/admin.service.ts",
            action: "Create",
            notes: "Backend service",
          },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mockQueryFn = jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            taskId: "TASK-001",
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: [],
            preconditions: [],
          }),
        };
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
      _setQueryFn(mockQueryFn as any);

      await generateBlueprint(backendTask, mockAdapter);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockQueryFn).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const promptArg: string = (mockQueryFn as jest.Mock).mock.calls[0][0].prompt;
      expect(promptArg).not.toContain("Contract Sources Directive");
    });
  });

  describe("extractBlueprintJson", () => {
    const validJson = JSON.stringify({
      taskId: "TASK-099",
      fileAnalyses: [
        {
          filePath: "a.ts",
          action: "Modify",
          currentStructure: "fn()",
          integrationPoints: "line 10",
          patternToFollow: "b.ts:5",
        },
      ],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: ["no stubs"],
      preconditions: [],
    });

    it("strategy 1: parses pure JSON directly", () => {
      const result = extractBlueprintJson(validJson);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
      expect(result!.fileAnalyses).toHaveLength(1);
    });

    it("strategy 2: extracts from ```json code fence", () => {
      const text = `Here's the blueprint:\n\n\`\`\`json\n${validJson}\n\`\`\`\n\nDone!`;
      const result = extractBlueprintJson(text);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
    });

    it("strategy 2: extracts from ``` code fence without json tag", () => {
      const text = `Blueprint:\n\n\`\`\`\n${validJson}\n\`\`\``;
      const result = extractBlueprintJson(text);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
    });

    it("strategy 3: finds balanced braces with taskId anchor", () => {
      const text = `Perfect! After reading all files, I produced this:\n\n${validJson}\n\nHope this helps.`;
      const result = extractBlueprintJson(text);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
      expect(result!.antiPatterns).toEqual(["no stubs"]);
    });

    it("strategy 3: ignores braces inside JSON strings", () => {
      const jsonWithCodeBraces = JSON.stringify({
        taskId: "TASK-099",
        fileAnalyses: [
          {
            filePath: "a.ts",
            action: "Modify",
            currentStructure: "fn()",
            integrationPoints: "line 10",
            patternToFollow: "b.ts:5",
          },
        ],
        codeExamples: [
          {
            file: "a.ts",
            description: "object return",
            before: "function oldThing() { return null; }",
            after: "function newThing() { return { ok: true, nested: { value: 1 } }; }",
          },
        ],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      });
      const text = `I now have all the information needed.\n\n${jsonWithCodeBraces}\n\nThis blueprint covers the work.`;
      const result = extractBlueprintJson(text);

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
      expect(result!.codeExamples[0].after).toContain("nested");
    });

    it("returns null for text with no valid JSON", () => {
      const result = extractBlueprintJson("No JSON here at all, just prose.");
      expect(result).toBeNull();
    });

    it("returns null for JSON missing required fields", () => {
      const result = extractBlueprintJson(JSON.stringify({ foo: "bar" }));
      expect(result).toBeNull();
    });

    it("returns null for JSON with fileAnalyses as non-array", () => {
      const result = extractBlueprintJson(JSON.stringify({ taskId: "T-1", fileAnalyses: "nope" }));
      expect(result).toBeNull();
    });

    it("skips non-blueprint JSON blocks and finds the real one", () => {
      const decoy = JSON.stringify({ type: "config", value: 42 });
      const text = `Config: ${decoy}\n\nBlueprint: ${validJson}`;
      const result = extractBlueprintJson(text);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-099");
    });
  });
});
