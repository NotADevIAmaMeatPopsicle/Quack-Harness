import { TaskPriority, TaskStatus, type ParsedTask } from "../../src/core/types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { buildEnrichmentPrompt } from "../../src/gate/enrichment-prompt";
import {
  _setQueryFn,
  analyzeEnrichmentGrounding,
  enrichTask,
  extractSpecBody,
} from "../../src/gate/enrichment-agent";

jest.mock("../../src/gate/pattern-extractor", () => ({
  extractPatterns: jest.fn().mockResolvedValue({ patterns: [], siblingPatterns: [] }),
  formatPatternsForPrompt: jest.fn().mockReturnValue(""),
}));

interface MockMessage {
  type: string;
  subtype?: string;
  result?: string;
  message?: {
    content: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

function queryWith(messages: MockMessage[]) {
  return function (): AsyncGenerator<MockMessage, void> {
    let index = 0;
    return {
      next: () =>
        Promise.resolve(
          index < messages.length
            ? { done: false as const, value: messages[index++] }
            : { done: true as const, value: undefined },
        ),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
      throw: (error: unknown) =>
        Promise.reject(error instanceof Error ? error : new Error(String(error))),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
}

function task(
  rawContent = "# TASK-923: Grounding\n\n## Problem Statement\nEnrich safely.",
): ParsedTask {
  return {
    id: "TASK-923",
    title: "Grounding",
    priority: "P2-MEDIUM" as TaskPriority,
    effort: "2 hours",
    status: "READY" as TaskStatus,
    blockedBy: [],
    blocks: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    conventions: [],
    tags: ["enrichment"],
    problemStatement: "Enrich safely.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [],
    successCriteria: ["Ground claims"],
    testingRequirements: ["Test grounding"],
    contextReferences: [],
    rawContent,
  };
}

function adapter(): ProjectAdapter {
  return {
    config: {
      version: "1.0",
      project: {
        name: "grounding-test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {
        model: "claude-sonnet-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 20,
        maxBudgetPerTask: 5,
        maxRetries: 1,
      },
      verification: {
        commands: [{ name: "test", command: "npm test", required: true, timeout: 300 }],
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
        autoCreatePr: false,
        autoPush: false,
      },
      logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
    },
    projectRoot: "/fake/project/root",
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "sha256:test",
      normalizedConfig: {} as ProjectAdapter["config"],
      machineLocalFields: [],
    },
  };
}

const enrichedSpec = `# TASK-923: Grounding

## Current State

The migration \`src/migrations/20260907000000-grounding.js\` defines the
\`hot_enabled\` column and \`loadGrounding()\` reads \`GROUNDING_MODE\`.

## Success Criteria
- [ ] Ground claims

## Testing Requirements
- [ ] Test grounding

## Grounded By

- Read: src/migrations/20260907000000-grounding.js (columns: hot_enabled)
- Grep: 'loadGrounding' in src/ (signature: loadGrounding())
- Glob: src/config/*.ts (environment variable: GROUNDING_MODE)
`;

describe("TASK-923 enrichment grounding contract", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  test("prompt requires actual Read/Grep/Glob calls and trace-matching footer evidence", () => {
    const prompt = buildEnrichmentPrompt(task(), [], [], "");

    expect(prompt).toContain("actual Read, Grep, or Glob tool call");
    expect(prompt).toContain("must match the tool name and input recorded in the SDK trace");
    expect(prompt).toContain("- Glob: src/config/*.ts");
  });

  test("preserves Grounded By byte-for-byte while reporting missing real tool evidence", () => {
    expect(extractSpecBody(`preface\n${enrichedSpec}`)).toBe(enrichedSpec);

    const observation = analyzeEnrichmentGrounding(task().rawContent, enrichedSpec, []);

    expect(observation.hasGroundedByFooter).toBe(true);
    expect(observation.observedTools).toEqual([]);
    expect(observation.unsupportedClaims).toEqual(
      expect.arrayContaining([
        "src/migrations/20260907000000-grounding.js",
        "hot_enabled",
        "loadGrounding()",
        "GROUNDING_MODE",
      ]),
    );
    expect(observation.warnings).toContain("grounding_evidence_without_observed_tool_use");
  });

  test("accepts footer evidence backed by actual Read/Grep/Glob tool calls", () => {
    const observation = analyzeEnrichmentGrounding(task().rawContent, enrichedSpec, [
      {
        name: "Read",
        input: { file_path: "/fake/project/root/src/migrations/20260907000000-grounding.js" },
      },
      { name: "Grep", input: { pattern: "loadGrounding", path: "src/" } },
      { name: "Glob", input: { pattern: "src/config/*.ts" } },
    ]);

    expect(observation.observedTools.map((tool) => tool.name)).toEqual(["Read", "Grep", "Glob"]);
    expect(observation.unsupportedEvidence).toEqual([]);
    expect(observation.unsupportedClaims).toEqual([]);
    expect(observation.warnings).toEqual([]);
  });

  test("treats explicit operator-confirmation labels as an intentional escape hatch", () => {
    const content = `# TASK-923: Grounding

## Current State

needs operator confirmation: verify whether \`STAGING_DEPLOY_SHA\` is current.

## Grounded By

Claims marked "needs operator confirmation":
- The staging deploy SHA requires a runtime probe.
`;

    const observation = analyzeEnrichmentGrounding(task().rawContent, content, []);

    expect(observation.concreteClaims).not.toContain("STAGING_DEPLOY_SHA");
    expect(observation.unsupportedClaims).toEqual([]);
    expect(observation.warnings).toEqual([]);
  });

  test("collects real grounding calls from the SDK assistant trace", async () => {
    _setQueryFn(
      queryWith([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: {
                  file_path: "/fake/project/root/src/migrations/20260907000000-grounding.js",
                },
              },
              {
                type: "tool_use",
                name: "Grep",
                input: { pattern: "loadGrounding", path: "src/" },
              },
              {
                type: "tool_use",
                name: "Glob",
                input: { pattern: "src/config/*.ts" },
              },
            ],
          },
        },
        { type: "result", subtype: "success", result: enrichedSpec },
      ]) as Parameters<typeof _setQueryFn>[0],
    );
    const observations: ReturnType<typeof analyzeEnrichmentGrounding>[] = [];
    const warnings: string[] = [];

    const result = await enrichTask(task(), [], [], adapter(), {
      onGroundingObservation: (observation) => observations.push(observation),
      warn: (message) => warnings.push(message),
    });

    expect(result).toBe(enrichedSpec);
    expect(observations[0]?.observedTools.map((tool) => tool.name)).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(observations[0]?.warnings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("returns the enrichment unchanged and emits a warning instead of blocking", async () => {
    const unsupportedSpec = enrichedSpec.replace(
      /- Read:[\s\S]*?- Glob:[^\n]*\n/,
      "No Read/Grep/Glob evidence was recorded.\n",
    );
    _setQueryFn(
      queryWith([{ type: "result", subtype: "success", result: unsupportedSpec }]) as Parameters<
        typeof _setQueryFn
      >[0],
    );
    const observations: ReturnType<typeof analyzeEnrichmentGrounding>[] = [];
    const warnings: string[] = [];

    const result = await enrichTask(task(), [], [], adapter(), {
      onGroundingObservation: (observation) => observations.push(observation),
      warn: (message) => warnings.push(message),
    });

    expect(result).toBe(unsupportedSpec);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.footerEvidence).toEqual([]);
    expect(observations[0]?.unsupportedClaims).toContain("hot_enabled");
    expect(warnings.join("\n")).toContain("unsupported concrete claims");
  });
});
