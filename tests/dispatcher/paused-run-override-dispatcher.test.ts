import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, GateResult, ParsedTask } from "../../src/core/types";

const mockRunReadinessGate = jest.fn<
  Promise<GateResult>,
  [ParsedTask, ProjectAdapter, Record<string, unknown> | undefined, unknown?]
>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (
    ...args: [ParsedTask, ProjectAdapter, Record<string, unknown> | undefined, unknown?]
  ) => mockRunReadinessGate(...args),
}));

const mockGenerateBlueprint = jest.fn<
  Promise<Blueprint>,
  [ParsedTask, ProjectAdapter, { model?: string; maxTurns?: number }?]
>();
jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: (
    ...args: [ParsedTask, ProjectAdapter, { model?: string; maxTurns?: number }?]
  ) => mockGenerateBlueprint(...args),
  createMinimalBlueprint: (taskId: string) => ({
    taskId,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  }),
}));

import { dispatchTask } from "../../src/dispatcher/dispatcher";

const TASK_ID = "TASK-500";

function taskSpec(): string {
  return `# ${TASK_ID}: Override recovery

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 4 hours
- **Status:** BACKLOG
- **Blocked By:** []
- **Tags:** [test]

## Problem Statement
Replace an archived plan with a genuinely fresh plan.

## Current State
An earlier plan is pending.

## Recommended Approach
Archive the old run before generating a new plan.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/new.ts | Create | Fresh implementation |

## Success Criteria
- [ ] The fresh plan replaces the old plan.

## Testing Requirements
- [ ] Verify recovery state.
`;
}

function adapterFor(projectRoot: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "paused-run-override-test",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 10,
      maxBudgetPerTask: 1,
      maxRetries: 0,
    },
    verification: { commands: [], conventionChecks: [] },
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
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
    preflight: {
      autoRun: false,
      complexityThresholds: {
        maxFilesBeforeDecompose: 10,
        maxCriteriaBeforeDecompose: 10,
        maxContextTokensBeforeDecompose: 100_000,
        maxIndependentFeatures: 10,
      },
      blueprintApproval: {
        enabled: true,
        // The fresh one-file plan must pause, which lets this test inspect the
        // new record before any worker or judge stage can run.
        autoApproveWhen: {
          maxFiles: 0,
          maxCriteria: 0,
          minBlueprintScore: 0,
          requireDecomposition: false,
        },
      },
    },
  };

  return {
    config,
    projectRoot,
    conventionsDoc: "Test conventions.",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "paused-run-override-test",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("direct dispatcher paused-run override", () => {
  let projectRoot: string;
  let logDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-direct-override-"));
    logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(logDir, "approvals"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "docs", "tasks", `${TASK_ID}-override.md`),
      taskSpec(),
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("archives and clears the old records before paying for a fresh gate and plan", async () => {
    const liveApproval = path.join(logDir, "approvals", `${TASK_ID}.json`);
    const liveCheckpoint = path.join(logDir, `checkpoint-${TASK_ID}.json`);
    const oldCreatedAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      liveApproval,
      JSON.stringify(
        {
          taskId: TASK_ID,
          state: "pending",
          createdAt: oldCreatedAt,
          blueprint: {
            taskId: TASK_ID,
            fileAnalyses: [],
            codeExamples: [],
            verificationPatterns: [],
            antiPatterns: ["OLD-PAID-BRIEF"],
            preconditions: [],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(
      liveCheckpoint,
      JSON.stringify(
        {
          taskId: TASK_ID,
          sessionId: "old-paid-session",
          completedStages: ["gate", "blueprint"],
          totalCostUsd: 2.5,
          retriesUsed: 0,
          updatedAt: oldCreatedAt,
          startedAt: oldCreatedAt,
        },
        null,
        2,
      ),
      "utf-8",
    );

    mockRunReadinessGate.mockImplementationOnce(() => {
      // This is the spend boundary. Old live state must be gone before it.
      expect(fs.existsSync(liveApproval)).toBe(false);
      expect(fs.existsSync(liveCheckpoint)).toBe(false);
      return Promise.resolve({ outcome: "pass", task: {} as ParsedTask });
    });
    mockGenerateBlueprint.mockResolvedValueOnce({
      taskId: TASK_ID,
      fileAnalyses: [
        {
          filePath: "src/new.ts",
          action: "Create",
          currentStructure: "new file",
          integrationPoints: "fresh entry point",
          patternToFollow: "project conventions",
        },
      ],
      codeExamples: [],
      verificationPatterns: [],
      antiPatterns: ["FRESH-BRIEF"],
      preconditions: [],
      fidelity: {
        status: "ok",
        violations: [],
        checkedAt: new Date().toISOString(),
        scope: "typed-surface+file-existence",
      },
    });

    const result = await dispatchTask(TASK_ID, adapterFor(projectRoot), {
      overridePausedRun: true,
      skipBranch: true,
      skipPr: true,
      disableEvents: true,
    });

    expect(result.outcome).toBe("awaiting_approval");
    expect(mockRunReadinessGate).toHaveBeenCalledTimes(1);
    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);

    const freshApproval = JSON.parse(fs.readFileSync(liveApproval, "utf-8")) as {
      createdAt: string;
      blueprint: { antiPatterns: string[] };
    };
    expect(freshApproval.createdAt).not.toBe(oldCreatedAt);
    expect(freshApproval.blueprint.antiPatterns).toEqual(["FRESH-BRIEF"]);

    const archivedApproval = fs
      .readdirSync(path.join(logDir, "approvals", "archive"))
      .map((file) => fs.readFileSync(path.join(logDir, "approvals", "archive", file), "utf-8"))
      .join("\n");
    expect(archivedApproval).toContain("OLD-PAID-BRIEF");
    const archivedCheckpoint = fs
      .readdirSync(path.join(logDir, "checkpoints-archive"))
      .filter((file) => file.endsWith(".json") && !file.endsWith(".manifest.json"))
      .map((file) => fs.readFileSync(path.join(logDir, "checkpoints-archive", file), "utf-8"))
      .join("\n");
    expect(archivedCheckpoint).toContain("old-paid-session");
  });
});
