import { ParsedTask, TaskPriority, TaskStatus, TaskType } from "../../src/core/types";
import { ProjectAdapter } from "../../src/core/adapter-loader";
import { buildEnrichmentPrompt } from "../../src/gate/enrichment-prompt";
import { enrichTask, extractSpecBody, _setQueryFn } from "../../src/gate/enrichment-agent";

// ─── Mocks ────────────────────────────────────────────────────────────

jest.mock("../../src/gate/pattern-extractor", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const actual: Record<string, unknown> = jest.requireActual("../../src/gate/pattern-extractor");
  return {
    ...actual,
    extractPatterns: jest.fn().mockResolvedValue({ patterns: [], siblingPatterns: [] }),
  };
});

jest.mock("../../src/gate/schema-validator", () => ({
  validateTaskSchema: jest.fn(),
}));

jest.mock("../../src/gate/depth-evaluator", () => ({
  evaluateTaskDepth: jest.fn(),
}));

jest.mock("../../src/gate/enrichment-agent", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const actual: Record<string, unknown> = jest.requireActual("../../src/gate/enrichment-agent");
  return {
    ...actual,
    enrichTask: jest.fn(actual.enrichTask as (...args: unknown[]) => unknown),
  };
});

import { validateTaskSchema } from "../../src/gate/schema-validator";
import { evaluateTaskDepth } from "../../src/gate/depth-evaluator";
import { runReadinessGate } from "../../src/gate/gate";
import { enrichTask as enrichTaskMocked } from "../../src/gate/enrichment-agent";

const mockedValidateTaskSchema = validateTaskSchema as jest.MockedFunction<
  typeof validateTaskSchema
>;
const mockedEvaluateTaskDepth = evaluateTaskDepth as jest.MockedFunction<typeof evaluateTaskDepth>;
const mockedEnrichTask = enrichTaskMocked as jest.MockedFunction<typeof enrichTaskMocked>;

// ─── Mock SDK types ────────────────────────────────────────────────────

interface MockSDKMessage {
  type: string;
  subtype?: string;
  result?: string;
}

type MockQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<MockSDKMessage, void>;

// ─── Test helpers ──────────────────────────────────────────────────────

function* makeSuccessGenerator(resultText: string): Generator<MockSDKMessage, void> {
  yield {
    type: "result",
    subtype: "success",
    result: resultText,
  };
}

function createMockQueryFn(resultText: string): {
  fn: MockQueryFn;
  calls: Array<{ prompt: string; options?: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; options?: Record<string, unknown> }> = [];

  const fn = function (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncGenerator<MockSDKMessage, void> {
    calls.push(params);
    const syncGen = makeSuccessGenerator(resultText);
    const asyncGen: AsyncGenerator<MockSDKMessage, void> = {
      next: () => Promise.resolve(syncGen.next()),
      return: (value: void) => Promise.resolve(syncGen.return(value)),
      throw: (e: unknown) => Promise.resolve(syncGen.throw(e)),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return asyncGen;
  };

  return { fn, calls };
}

function makeValidTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const baseTask: ParsedTask = {
    id: "TASK-042",
    title: "Add email validation to registration form",
    priority: "P1-HIGH" as TaskPriority,
    effort: "2-3 hours",
    status: "BACKLOG" as TaskStatus,
    blockedBy: [],
    blocks: ["TASK-043"],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    conventions: ["ADR-012"],
    tags: ["backend", "validation"],
    problemStatement: "The registration form accepts any string as an email address.",
    currentState: "src/controllers/auth.controller.ts has a register() handler.",
    recommendedApproach: "Add a validateEmail() function in src/utils/validators.ts.",
    filesToModify: [
      {
        path: "src/utils/validators.ts",
        action: "Create",
        notes: "Email validation function",
      },
    ],
    successCriteria: [
      "Invalid emails return 422 with field-level error",
      "All existing auth tests still pass",
    ],
    testingRequirements: ["Unit test for validateEmail() with valid and invalid cases"],
    contextReferences: ["ADR-012: Input validation patterns"],
    rawContent:
      "# TASK-042: Add email validation to registration form\n\n## Problem Statement\nThe registration form accepts any string as an email...",
  };

  return { ...baseTask, ...overrides };
}

function makeAdapter(overrides: Partial<ProjectAdapter> = {}): ProjectAdapter {
  return {
    config: {
      version: "1.0",
      project: {
        name: "test-project",
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
        allowedBashPatterns: ["npm test *"],
        deniedBashPatterns: ["rm *"],
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
    },
    projectRoot: "/fake/project/root",
    conventionsDoc: "Use Express + Sequelize. camelCase in JS.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "sha256:test",
      normalizedConfig: {} as ProjectAdapter["config"],
      machineLocalFields: [],
    },
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("extractSpecBody (TASK-907)", () => {
  test("returns input unchanged when content starts at first column with `# TASK-`", () => {
    const content = "# TASK-042: Title\n\n## Metadata\n- foo\n";
    expect(extractSpecBody(content)).toBe(content);
  });

  test("strips LLM preamble before the first `# TASK-` heading", () => {
    const content =
      "Now I have all the information needed. Let me write the complete enriched task spec:\n\n---\n\n# TASK-042: Title\n\n## Metadata\n- foo\n";
    const body = extractSpecBody(content);
    expect(body).toBe("# TASK-042: Title\n\n## Metadata\n- foo\n");
    expect(body?.startsWith("# TASK-")).toBe(true);
  });

  test("returns null when no `# TASK-` heading is present", () => {
    const content = "Just some prose with no heading.\n## Some H2\n- bullet\n";
    expect(extractSpecBody(content)).toBeNull();
  });

  test("returns null on empty input", () => {
    expect(extractSpecBody("")).toBeNull();
  });

  test("does NOT match `## TASK-` or inline `# TASK-` mid-line", () => {
    const content = "Inline reference to # TASK-042 but no heading.\n## TASK-042 H2 not H1.\n";
    expect(extractSpecBody(content)).toBeNull();
  });

  test("preserves multi-paragraph + nested headings after the first H1", () => {
    const content =
      "preamble\n\n# TASK-042: Title\n\n## Metadata\n## Problem Statement\n\nSome details.\n\n## Files\n";
    const body = extractSpecBody(content);
    expect(body).toContain("## Problem Statement");
    expect(body).toContain("## Files");
    expect(body?.startsWith("# TASK-042")).toBe(true);
  });

  // TASK-923: the enrichment prompt instructs the LLM to append a `## Grounded By`
  // footer at the end of the enriched spec listing the Read/Grep calls that
  // verified each concrete claim. extractSpecBody must preserve it.
  test("preserves trailing `## Grounded By` footer (TASK-923)", () => {
    const content = [
      "# TASK-1023: Verify TASK-1020-A Migration Ledger",
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "",
      "## Success Criteria",
      "- [ ] SequelizeMeta records the migration",
      "",
      "## Grounded By",
      "",
      "This enrichment's concrete file paths, column names, and signatures were verified by:",
      "- Read: src/migrations/20260506150000-add-per-tier-external-provider-markers.js (columns: last_appointments_delta_at, ...)",
      "- Grep: 'CREATE TABLE.*external-provider_credentials' in src/init-scripts/",
      "",
      'Claims marked "needs operator confirmation":',
      "- The deploy SHA currently running on staging (requires staging probe).",
      "",
    ].join("\n");
    const body = extractSpecBody(content);
    expect(body).not.toBeNull();
    expect(body).toContain("## Grounded By");
    expect(body).toContain(
      "Read: src/migrations/20260506150000-add-per-tier-external-provider-markers.js",
    );
    expect(body).toContain("needs operator confirmation");
  });
});

describe("buildEnrichmentPrompt", () => {
  test("should include task rawContent in the prompt", () => {
    const task = makeValidTask();
    const prompt = buildEnrichmentPrompt(
      task,
      ["Vague problem statement"],
      ["Add file paths"],
      "Use camelCase",
    );

    expect(prompt).toContain(task.rawContent);
  });

  test("should include deficiencies as bullet list", () => {
    const deficiencies = ["Problem statement is too vague", "No specific file paths mentioned"];

    const prompt = buildEnrichmentPrompt(makeValidTask(), deficiencies, [], "conventions");

    expect(prompt).toContain("- Problem statement is too vague");
    expect(prompt).toContain("- No specific file paths mentioned");
  });

  test("should include suggestions as bullet list", () => {
    const suggestions = ["Add file list", "Add success criteria checklist"];

    const prompt = buildEnrichmentPrompt(makeValidTask(), [], suggestions, "conventions");

    expect(prompt).toContain("- Add file list");
    expect(prompt).toContain("- Add success criteria checklist");
  });

  // TASK-923 grounding rule and Grounded By footer format.
  test("includes the TASK-923 grounding rule in the Instructions block", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions");

    // The grounding instruction calls out the specific kinds of facts that
    // require a Read/Grep before being asserted. Test the load-bearing phrases.
    expect(prompt).toContain("Ground concrete technical claims in real reads");
    expect(prompt).toContain("MUST be verified by a Read or Grep call");
    expect(prompt).toContain("needs operator confirmation");
    // The instruction is positioned between step 6 and step 7.
    expect(prompt).toMatch(/6\.5\.\s+\*\*Ground concrete technical claims/);
  });

  test("documents the Grounded By footer format with example Read/Grep entries", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions");

    expect(prompt).toContain("## Grounded By footer");
    expect(prompt).toContain("## Grounded By");
    // The example shows Read + Grep entries and the operator-confirmation escape hatch.
    expect(prompt).toContain(
      "- Read: src/migrations/20260506150000-add-per-tier-external-provider-markers.js",
    );
    expect(prompt).toContain("- Grep: 'CREATE TABLE.*external-provider_credentials'");
    expect(prompt).toContain('Claims marked "needs operator confirmation"');
  });

  test("should include conventions document", () => {
    const conventions = "Use Express + Sequelize. camelCase in JS, snake_case in DB.";

    const prompt = buildEnrichmentPrompt(
      makeValidTask(),
      ["deficiency"],
      ["suggestion"],
      conventions,
    );

    expect(prompt).toContain(conventions);
  });

  test("should include all instruction steps", () => {
    const prompt = buildEnrichmentPrompt(
      makeValidTask(),
      ["deficiency"],
      ["suggestion"],
      "conventions",
    );

    expect(prompt).toContain("Draft the COMPLETE enriched task spec immediately");
    expect(prompt).toContain("Use the focused reading list first");
    expect(prompt).toContain("Fill in missing details");
    expect(prompt).toContain("Make success criteria specific and testable");
    expect(prompt).toContain("Add relevant convention/ADR references");
    expect(prompt).toContain("Output only the COMPLETE enriched task spec");
    expect(prompt).toContain("Do NOT change the task's intent or scope");
  });

  test("should front-load writing instruction before reading instruction", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions", {
      focusedFilePaths: ["src/a.ts"],
    });
    const writeIdx = prompt.indexOf("Draft the COMPLETE enriched task spec immediately");
    const readIdx = prompt.indexOf("Use the focused reading list first");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeLessThan(readIdx);
  });

  test("should include the system context preamble", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "");

    expect(prompt).toContain(
      "You are enriching a task specification to make it implementation-ready",
    );
    expect(prompt).toContain("flagged as insufficiently detailed");
  });

  test("should handle empty deficiencies and suggestions", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions");

    expect(prompt).toContain("- None specified");
  });

  test("should handle empty conventions doc", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), ["deficiency"], ["suggestion"], "");

    expect(prompt).toContain("## Project Conventions\n");
  });

  test("should include codebase patterns section when extractedPatterns provided", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions", {
      extractedPatterns: {
        patterns: [
          {
            filePath: "src/services/foo.ts",
            exists: true,
            exports: ["fooService", "createFoo"],
            wrapperPattern: "serviceWrapper",
            errorHandling: ["ValidationError", "NotFoundError"],
            importPatterns: ["../models/foo", "../utils/error-handler"],
            fieldNaming: "camelCase",
            lineCount: 120,
            snippet: "import { serviceWrapper } from '../utils/error-handler';",
          },
        ],
        siblingPatterns: [],
      },
    });

    expect(prompt).toContain("## Codebase Patterns (Pre-Extracted)");
    expect(prompt).toContain("src/services/foo.ts");
    expect(prompt).toContain("serviceWrapper");
    expect(prompt).toContain("fooService, createFoo");
    expect(prompt).toContain("ground truth");
  });

  test("should include ADR compliance section when adrDocs provided with matching tags", () => {
    const task = makeValidTask({ tags: ["backend", "repository"] });
    const prompt = buildEnrichmentPrompt(task, [], [], "conventions", {
      adrDocs: {
        "ADR-012":
          "# ADR-012: Layered Architecture\nRoutes → Controllers → Services → Repositories",
        "ADR-013": "# ADR-013: Repository Pattern\nAll data access through repositories",
        "ADR-001": "# ADR-001: API Response Format\n{ status, data }",
      },
    });

    expect(prompt).toContain("## ADR Compliance Requirements");
    expect(prompt).toContain("ADR-012");
    expect(prompt).toContain("ADR-013");
  });

  test("should include enhanced directives when patterns or ADRs are provided", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions", {
      extractedPatterns: {
        patterns: [
          {
            filePath: "src/foo.ts",
            exists: true,
            exports: [],
            wrapperPattern: null,
            errorHandling: [],
            importPatterns: [],
            fieldNaming: "unknown",
            lineCount: 10,
            snippet: "",
          },
        ],
        siblingPatterns: [],
      },
    });

    expect(prompt).toContain("Validate that any code examples in the spec");
    expect(prompt).toContain("Resolve any external references");
    expect(prompt).toContain("Check for contradictions");
    expect(prompt).toContain("error handling is specified per failure mode");
  });

  test("should NOT include enhanced directives when no options provided", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions");

    expect(prompt).not.toContain("Validate that any code examples in the spec");
    expect(prompt).not.toContain("Resolve any external references");
  });

  test("should include sibling patterns for Create actions", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions", {
      extractedPatterns: {
        patterns: [
          {
            filePath: "src/new-file.ts",
            exists: false,
            exports: [],
            wrapperPattern: null,
            errorHandling: [],
            importPatterns: [],
            fieldNaming: "unknown",
            lineCount: 0,
            snippet: "",
          },
        ],
        siblingPatterns: [
          {
            filePath: "src/existing-sibling.ts",
            exists: true,
            exports: ["siblingFn"],
            wrapperPattern: "controllerWrapper",
            errorHandling: ["AppError"],
            importPatterns: [],
            fieldNaming: "camelCase",
            lineCount: 80,
            snippet: "",
          },
        ],
      },
    });

    expect(prompt).toContain("Sibling Files");
    expect(prompt).toContain("existing-sibling.ts");
    expect(prompt).toContain("controllerWrapper");
  });

  test("should select ADRs from task.conventions field", () => {
    const task = makeValidTask({ conventions: ["ADR-012"], tags: [] });
    const prompt = buildEnrichmentPrompt(task, [], [], "conventions", {
      adrDocs: {
        "ADR-012": "# ADR-012: Layered Architecture",
        "ADR-099": "# ADR-099: Unrelated",
      },
    });

    expect(prompt).toContain("ADR-012");
    expect(prompt).not.toContain("ADR-099");
  });

  test("should include focused file list when provided", () => {
    const prompt = buildEnrichmentPrompt(makeValidTask(), [], [], "conventions", {
      focusedFilePaths: ["src/a.ts", "src/b.ts"],
    });

    expect(prompt).toContain("## Focused Reading List (Max 10 Files)");
    expect(prompt).toContain("1. src/a.ts");
    expect(prompt).toContain("2. src/b.ts");
  });
});

describe("enrichTask", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  test("should call SDK with read-only tools and correct options", async () => {
    const enrichedSpec = "# TASK-042: Enriched spec content";
    const { fn, calls } = createMockQueryFn(enrichedSpec);
    _setQueryFn(fn);

    const task = makeValidTask();
    const adapter = makeAdapter();

    await enrichTask(task, ["Vague problem"], ["Add details"], adapter);

    expect(calls).toHaveLength(1);
    const callArgs = calls[0];
    expect(callArgs?.options).toEqual(
      expect.objectContaining({
        allowedTools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
        permissionMode: "bypassPermissions",
        model: "claude-sonnet-4-6",
        maxTurns: 35,
        cwd: "/fake/project/root",
      }),
    );
  });

  test("should include focused files from Files to Modify and Files to Create in prompt", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const rawContent = `# TASK-042: Example

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2-3 hours
- **Status:** READY

## Problem Statement
Example

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/existing-a.ts | Modify | A |

## Files to Create
| File | Purpose |
|------|---------|
| src/new-file-b.ts | New |

## Success Criteria
- [ ] One

## Testing Requirements
- [ ] One
`;

    const task = makeValidTask({
      rawContent,
      filesToModify: [{ path: "src/existing-a.ts", action: "Modify", notes: "A" }],
    });

    await enrichTask(task, [], [], makeAdapter());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("src/existing-a.ts");
    expect(calls[0]?.prompt).toContain("src/new-file-b.ts");
  });

  test("should cap focused file list at 10 files", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const createRows = Array.from({ length: 12 }, (_, i) => `| src/new-${i + 1}.ts | New |`).join(
      "\n",
    );
    const rawContent = `# TASK-042: Example

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2-3 hours
- **Status:** READY

## Problem Statement
Example

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/existing.ts | Modify | Existing |

## Files to Create
| File | Purpose |
|------|---------|
${createRows}

## Success Criteria
- [ ] One

## Testing Requirements
- [ ] One
`;

    await enrichTask(
      makeValidTask({
        rawContent,
        filesToModify: [{ path: "src/existing.ts", action: "Modify", notes: "Existing" }],
      }),
      [],
      [],
      makeAdapter(),
    );

    const prompt = calls[0]?.prompt ?? "";
    const focusedSection =
      prompt.match(/## Focused Reading List \(Max 10 Files\)([\s\S]*?)## Instructions/)?.[1] ?? "";
    expect(focusedSection).toContain("src/new-9.ts");
    expect(focusedSection).not.toContain("src/new-11.ts");
    expect(focusedSection).not.toContain("src/new-12.ts");
  });

  test("should apply 1200s timeout and call unref on timer", async () => {
    const { fn } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const unref = jest.fn();
    const timeoutSpy = jest.spyOn(global, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
    ) => {
      void handler;
      return { unref, _timeout: timeout } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = jest
      .spyOn(global, "clearTimeout")
      .mockImplementation((() => undefined) as typeof clearTimeout);

    try {
      await enrichTask(makeValidTask(), [], [], makeAdapter());
      expect(timeoutSpy).toHaveBeenCalled();
      const timeoutValue = Number(timeoutSpy.mock.calls[0]?.[1] ?? 0);
      expect(timeoutValue).toBeGreaterThanOrEqual(1_199_000);
      expect(unref).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("should use adapter enrichModel by default", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const adapter = makeAdapter();
    adapter.config.agent.enrichModel = "claude-haiku-3-5-20241022";

    await enrichTask(makeValidTask(), [], [], adapter);

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        model: "claude-haiku-3-5-20241022",
      }),
    );
  });

  test("should allow overriding model via options", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    await enrichTask(makeValidTask(), [], [], makeAdapter(), { model: "claude-opus-4-6" });

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        model: "claude-opus-4-6",
      }),
    );
  });

  test("should allow overriding maxTurns via options", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    await enrichTask(makeValidTask(), [], [], makeAdapter(), { maxTurns: 5 });

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        maxTurns: 5,
      }),
    );
  });

  test("should return the enriched spec text from SDK result", async () => {
    const enrichedSpec = "# TASK-042: Fully enriched task specification\n\nDetailed content here.";
    const { fn } = createMockQueryFn(enrichedSpec);
    _setQueryFn(fn);

    const result = await enrichTask(makeValidTask(), ["deficiency"], ["suggestion"], makeAdapter());

    expect(result).toBe(enrichedSpec);
  });

  test("should throw if SDK returns no result message", async () => {
    const fn: MockQueryFn = function () {
      // Return an async generator that yields nothing useful
      const asyncGen: AsyncGenerator<MockSDKMessage, void> = {
        next: () => Promise.resolve({ done: true as const, value: undefined }),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
        throw: (e: unknown) => Promise.reject(e instanceof Error ? e : new Error(String(e))),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return asyncGen;
    };

    _setQueryFn(fn);

    await expect(enrichTask(makeValidTask(), [], [], makeAdapter())).rejects.toThrow(
      "Enrichment agent returned no success result",
    );
  });

  test("should use adapter projectRoot as cwd", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const adapter = makeAdapter({ projectRoot: "/my/project" });

    await enrichTask(makeValidTask(), [], [], adapter);

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        cwd: "/my/project",
      }),
    );
  });

  test("includes Reference entry paths in the focused file list sent to LLM", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const task = makeValidTask({
      rawContent:
        "# TASK-042\n## Problem Statement\nTest\n## Success Criteria\n- [ ] One\n## Testing Requirements\n- [ ] One",
      filesToModify: [{ path: "src/some/reference-file.ts", action: "Reference", notes: "" }],
    });
    await enrichTask(task, [], [], makeAdapter());

    expect(calls[0]?.prompt).toContain("src/some/reference-file.ts");
  });

  test("caps focused file list at 10 even with all Reference entries", async () => {
    const { fn, calls } = createMockQueryFn("enriched");
    _setQueryFn(fn);

    const filesToModify = Array.from({ length: 12 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      action: "Reference" as const,
      notes: "",
    }));
    const task = makeValidTask({
      rawContent:
        "# TASK-042\n## Problem Statement\nTest\n## Success Criteria\n- [ ] One\n## Testing Requirements\n- [ ] One",
      filesToModify,
    });
    await enrichTask(task, [], [], makeAdapter());

    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("src/file-0.ts");
    expect(prompt).not.toContain("src/file-10.ts");
    expect(prompt).not.toContain("src/file-11.ts");
  });
});

describe("runReadinessGate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("schema fail", () => {
    test("should reject with schema details when schema validation fails", async () => {
      const schemaResult = {
        valid: false,
        missing: ["title", "problem_statement"],
        warnings: ["current_state"],
      };
      mockedValidateTaskSchema.mockReturnValue(schemaResult);

      const task = makeValidTask();
      const adapter = makeAdapter();

      const result = await runReadinessGate(task, adapter);

      expect(result.outcome).toBe("rejected");
      if (result.outcome === "rejected") {
        expect(result.reason).toBe("Schema validation failed");
        expect(result.details).toEqual(schemaResult);
      }

      // Depth eval should NOT be called
      expect(mockedEvaluateTaskDepth).not.toHaveBeenCalled();
      // Enrichment should NOT be called
      expect(mockedEnrichTask).not.toHaveBeenCalled();
    });
  });

  describe("depth pass", () => {
    test("should return pass when schema and depth both pass", async () => {
      mockedValidateTaskSchema.mockReturnValue({
        valid: true,
        missing: [],
        warnings: [],
      });

      mockedEvaluateTaskDepth.mockResolvedValue({
        taskType: TaskType.Code,
        threshold: 4.7,
        ready: true,
        overallScore: 4.2,
        scores: { clarity: 4, scope: 5, testability: 4, conventions: 4 },
        deficiencies: [],
        enrichmentSuggestions: [],
      });

      const task = makeValidTask();
      const adapter = makeAdapter();

      const result = await runReadinessGate(task, adapter);

      expect(result.outcome).toBe("pass");
      if (result.outcome === "pass") {
        expect(result.task).toBe(task);
      }

      // Enrichment should NOT be called
      expect(mockedEnrichTask).not.toHaveBeenCalled();
    });
  });

  describe("depth fail, enrich", () => {
    test("should enrich and return enriched result when depth fails", async () => {
      mockedValidateTaskSchema.mockReturnValue({
        valid: true,
        missing: [],
        warnings: ["current_state"],
      });

      mockedEvaluateTaskDepth.mockResolvedValue({
        taskType: TaskType.Code,
        threshold: 4.7,
        ready: false,
        overallScore: 2.0,
        scores: { clarity: 2, scope: 2, testability: 2, conventions: 2 },
        deficiencies: ["Problem statement is vague"],
        enrichmentSuggestions: ["Add specific file paths"],
      });

      const enrichedContent = "# TASK-042: Enriched version with more detail";
      mockedEnrichTask.mockResolvedValue(enrichedContent);

      const task = makeValidTask();
      const adapter = makeAdapter();

      const result = await runReadinessGate(task, adapter);

      expect(result.outcome).toBe("enriched");
      if (result.outcome === "enriched") {
        expect(result.task.original).toBe(task);
        expect(result.task.enriched.rawContent).toBe(enrichedContent);
        expect(result.task.diff).toBe("enriched by agent");
        expect(result.task.approved).toBe(false);
      }

      // Enrichment should have been called with deficiencies and suggestions
      expect(mockedEnrichTask).toHaveBeenCalledWith(
        task,
        ["Problem statement is vague"],
        ["Add specific file paths"],
        adapter,
        { model: "claude-sonnet-4-6" },
      );
    });
  });

  describe("skipEnrichment", () => {
    test("should reject when depth fails and skipEnrichment is true", async () => {
      mockedValidateTaskSchema.mockReturnValue({
        valid: true,
        missing: [],
        warnings: [],
      });

      const depthResult = {
        taskType: TaskType.Code,
        threshold: 4.7,
        ready: false,
        overallScore: 2.0,
        scores: { clarity: 2, scope: 2, testability: 2, conventions: 2 },
        deficiencies: ["Vague scope"],
        enrichmentSuggestions: ["Add file list"],
      };
      mockedEvaluateTaskDepth.mockResolvedValue(depthResult);

      const task = makeValidTask();
      const adapter = makeAdapter();

      const result = await runReadinessGate(task, adapter, {
        skipEnrichment: true,
      });

      expect(result.outcome).toBe("rejected");
      if (result.outcome === "rejected") {
        expect(result.reason).toBe("Depth evaluation failed");
        expect(result.details).toEqual(depthResult);
      }

      // Enrichment should NOT be called
      expect(mockedEnrichTask).not.toHaveBeenCalled();
    });
  });

  describe("enriched task structure", () => {
    test("should preserve all original task fields in enriched task except rawContent", async () => {
      mockedValidateTaskSchema.mockReturnValue({
        valid: true,
        missing: [],
        warnings: [],
      });

      mockedEvaluateTaskDepth.mockResolvedValue({
        taskType: TaskType.Code,
        threshold: 4.7,
        ready: false,
        overallScore: 2.5,
        scores: { clarity: 3, scope: 2, testability: 2, conventions: 3 },
        deficiencies: ["Vague"],
        enrichmentSuggestions: ["Be specific"],
      });

      mockedEnrichTask.mockResolvedValue("# Enriched content");

      const task = makeValidTask();
      const adapter = makeAdapter();

      const result = await runReadinessGate(task, adapter);

      if (result.outcome === "enriched") {
        const enriched = result.task.enriched;
        // All fields should match original except rawContent
        expect(enriched.id).toBe(task.id);
        expect(enriched.title).toBe(task.title);
        expect(enriched.priority).toBe(task.priority);
        expect(enriched.effort).toBe(task.effort);
        expect(enriched.status).toBe(task.status);
        expect(enriched.problemStatement).toBe(task.problemStatement);
        expect(enriched.successCriteria).toEqual(task.successCriteria);
        expect(enriched.testingRequirements).toEqual(task.testingRequirements);
        // rawContent should be different
        expect(enriched.rawContent).toBe("# Enriched content");
        expect(enriched.rawContent).not.toBe(task.rawContent);
      } else {
        fail("Expected enriched outcome");
      }
    });
  });

  describe("pipeline ordering", () => {
    test("should call schema before depth, and depth before enrichment", async () => {
      const callOrder: string[] = [];

      mockedValidateTaskSchema.mockImplementation(() => {
        callOrder.push("schema");
        return { valid: true, missing: [], warnings: [] };
      });

      mockedEvaluateTaskDepth.mockImplementation(() => {
        callOrder.push("depth");
        return Promise.resolve({
          taskType: TaskType.Code,
          threshold: 4.7,
          ready: false,
          overallScore: 2.0,
          scores: { clarity: 2, scope: 2, testability: 2, conventions: 2 },
          deficiencies: ["vague"],
          enrichmentSuggestions: ["improve"],
        });
      });

      mockedEnrichTask.mockImplementation(() => {
        callOrder.push("enrich");
        return Promise.resolve("enriched content");
      });

      await runReadinessGate(makeValidTask(), makeAdapter());

      expect(callOrder).toEqual(["schema", "depth", "enrich"]);
    });
  });
});
