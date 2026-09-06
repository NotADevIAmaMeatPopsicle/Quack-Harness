import { buildSystemPrompt } from "../../src/worker/prompt-builder";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

function makeAdapter(overrides?: Partial<ProjectAdapter>): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
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
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
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
  };

  return {
    config,
    projectRoot: "/tmp/test",
    conventionsDoc: "Use async/await.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
    ...overrides,
  };
}

describe("Context Compression — PROGRESS.md", () => {
  it("should include Progress Tracking section in system prompt", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("## Progress Tracking");
  });

  it("should include PROGRESS.md instructions", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("PROGRESS.md");
  });

  it("should include all required progress file sections", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("## Completed");
    expect(result).toContain("## In Progress");
    expect(result).toContain("## Remaining");
    expect(result).toContain("## Issues Encountered");
    expect(result).toContain("## Cost So Far");
  });

  it("should instruct agent to update after each significant step", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Update it after completing each significant step");
  });

  it("should instruct agent to read existing progress file on resume", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("Always read PROGRESS.md");
    expect(result).toContain("resumed session");
  });

  it("should mention progress tracking for session interruptions", () => {
    const adapter = makeAdapter();
    const result = buildSystemPrompt(adapter, []);

    expect(result).toContain("session is interrupted");
  });
});
