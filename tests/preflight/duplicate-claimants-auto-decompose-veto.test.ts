// TASK-1338-B pre-change record: all four writeSpecs executions ran through
// writeSubtaskSpecs and FAILED at the intended refused-arm assertion after
// creating and committing a child. The writeSpecs:false arm is a CONTROL.
// The clean-store and warm-store tests also executed and FAILED because the
// runner persisted the refused run to both stores.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { listDuplicateClaimants } from "../../src/core/task-file-resolver";
import { parseTaskFile } from "../../src/core/task-parser";
import type { AdapterConfig, GateResult, ParsedTask, TaskContext } from "../../src/core/types";
import { QuackDB } from "../../src/db";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { PrepCache } from "../../src/monitor/prep-cache";
import { ReadinessService } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import type { SubtaskPlan } from "../../src/preflight/decompose-types";
import { runPreflight } from "../../src/preflight/preflight-runner";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  expectNoWriterArtifacts,
  removeFixture,
  taskSpec,
} from "../helpers/duplicate-claimants-fixture";

const mockRunReadinessGate = jest.fn<Promise<GateResult>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (...args: [ParsedTask, ProjectAdapter]) => mockRunReadinessGate(...args),
}));

const mockBlueprint: Blueprint = {
  taskId: "TASK-100",
  fileAnalyses: [
    {
      filePath: "src/fixture.ts",
      action: "Modify",
      currentStructure: "fixture",
      integrationPoints: "writer seam",
      patternToFollow: "guard then write",
    },
  ],
  codeExamples: [],
  verificationPatterns: [],
  antiPatterns: [],
  preconditions: [],
};
const mockGenerateBlueprint = jest.fn<Promise<Blueprint>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: (...args: [ParsedTask, ProjectAdapter]) => mockGenerateBlueprint(...args),
}));
jest.mock("../../src/blueprint/blueprint-prompt", () => ({
  formatBlueprintForPrompt: () => "## Blueprint\n\nfixture",
}));

const mockContext: TaskContext = {
  taskSpec: "fixture",
  conventions: {},
  conventionsSummary: "",
  relevantFiles: [],
  relatedPatterns: [],
  existingTests: [],
  claudeMd: [],
  contextSizeEstimate: {
    taskSpec: 100,
    blueprint: 100,
    repoMap: 0,
    relevantFiles: 0,
    relatedPatterns: 0,
    existingTests: 0,
    conventions: 0,
    claudeMd: 0,
    total: 200,
    withinBudget: true,
  },
};
const mockAssembleContext = jest.fn<Promise<TaskContext>, [ParsedTask, ProjectAdapter, string?]>();
jest.mock("../../src/dispatcher/context-assembler", () => ({
  assembleContext: (...args: [ParsedTask, ProjectAdapter, string?]) => mockAssembleContext(...args),
}));

const mockPlan: SubtaskPlan = {
  parentTaskId: "TASK-100",
  subtasks: [
    {
      id: "TASK-100-A",
      title: "auto child",
      filesToModify: [{ path: "src/fixture.ts", action: "Modify", notes: "fixture" }],
      successCriteria: ["child succeeds"],
      dependsOn: [],
      isFinal: true,
    },
  ],
};
const mockDecomposeTask = jest.fn<Promise<SubtaskPlan>, [ParsedTask, ProjectAdapter, Blueprint]>();
jest.mock("../../src/preflight/task-decomposer", () => ({
  decomposeTask: (...args: [ParsedTask, ProjectAdapter, Blueprint]) => mockDecomposeTask(...args),
}));

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// The provisioned Codex sandbox rejects git child processes. CI and admin
// runs do not set CODEX_THREAD_ID and execute the commit assertions normally.
const gitAvailable = process.env.CODEX_THREAD_ID === undefined;

function initRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["config", "user.email", "quack-test@example.com"]);
  git(root, ["config", "user.name", "Quack Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "docs/tasks"]);
  git(root, ["commit", "-m", "fixture"]);
}

function makeAdapter(root: string, writeSpecs: boolean): ProjectAdapter {
  const config = {
    version: "1.0",
    project: {
      name: "preflight-duplicate-fixture",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
    preflight: {
      autoRun: false,
      complexityThresholds: {
        maxFilesBeforeDecompose: 0,
        maxCriteriaBeforeDecompose: 0,
        maxContextTokensBeforeDecompose: 1,
        maxIndependentFeatures: 0,
      },
      autoDecompose: { enabled: true, maxSubtasks: 2, writeSpecs },
    },
  } as AdapterConfig;
  return {
    projectRoot: root,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    config,
    adapterBundle: {
      authority: "local",
      sharedHash: "fixture",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function configureMocks(task: ParsedTask): void {
  mockRunReadinessGate.mockReset();
  mockGenerateBlueprint.mockReset();
  mockAssembleContext.mockReset();
  mockDecomposeTask.mockReset();
  mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task });
  mockGenerateBlueprint.mockResolvedValue(mockBlueprint);
  mockAssembleContext.mockResolvedValue(mockContext);
  mockDecomposeTask.mockResolvedValue(mockPlan);
}

function eventWriter(events: Array<{ stage: string; payload: unknown }>): IEventWriter {
  return {
    sessionId: "preflight-test",
    taskId: "TASK-100",
    project: "fixture",
    emit(stage, payload) {
      events.push({ stage, payload });
    },
    recordSession() {},
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "preflight auto-decompose duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("returns the refused arm before drafts, writes, staging, or commit", async () => {
      const fixture = createDuplicateFixture("quack-preflight-veto-", kind, order);
      if (gitAvailable) initRepo(fixture.root);
      const beforeCommit = gitAvailable ? git(fixture.root, ["rev-parse", "HEAD"]) : undefined;
      const task = parseTaskFile(
        fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
        fixture.claimantPaths[0],
      );
      const events: Array<{ stage: string; payload: unknown }> = [];
      configureMocks(task);
      try {
        const result = await runPreflight(task, makeAdapter(fixture.root, true), {
          force: true,
          events: eventWriter(events),
        });
        const decomposition = result.decomposition as typeof result.decomposition & {
          refused?: { errorType: string; claimants: string[] };
        };
        expect(decomposition).toEqual({
          decomposed: false,
          subtaskIds: ["TASK-100-A"],
          subtaskFiles: [],
          refused: { errorType: "duplicate_claimants", claimants: fixture.claimants },
        });
        expect(
          events.filter((event) => event.stage === "preflight_auto_decompose_refused"),
        ).toHaveLength(1);
        expectClaimantsUnchanged(fixture);
        expectNoWriterArtifacts(fixture);
        if (gitAvailable) {
          expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(beforeCommit);
          expect(git(fixture.root, ["diff", "--cached", "--name-only"])).toBe("");
        }
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

it("writeSpecs false remains advisory and persists normally when contested", async () => {
  const fixture = createDuplicateFixture(
    "quack-preflight-advisory-",
    "cross-population",
    "forward",
  );
  const task = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  configureMocks(task);
  try {
    const result = await runPreflight(task, makeAdapter(fixture.root, false), { force: true });
    expect(result.decomposition).toMatchObject({
      decomposed: false,
      advisoryOnly: true,
      subtaskIds: ["TASK-100-A"],
    });
    expect(
      await new PrepCache(fixture.root).readPreflight("TASK-100", result.contentHash),
    ).not.toBeNull();
    expectClaimantsUnchanged(fixture);
  } finally {
    removeFixture(fixture.root);
  }
});

it("a clean refusal creates no entry in either store and resolves non-vacuously", async () => {
  const fixture = createDuplicateFixture(
    "quack-preflight-clean-store-",
    "cross-population",
    "forward",
  );
  const task = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  configureMocks(task);
  const prepCache = new PrepCache(fixture.root);
  const taskService = new TaskService(fixture.root, "docs/tasks");
  const readiness = new ReadinessService({ projectRoot: fixture.root, taskService, prepCache });
  try {
    const result = await runPreflight(task, makeAdapter(fixture.root, true), { force: true });
    expect(await prepCache.readPreflight("TASK-100", result.contentHash)).toBeNull();
    const state = await readiness.resolveCurrent("TASK-100");
    expect(state).not.toBeNull();
    expect(state?.preflight).toBeNull();
  } finally {
    readiness.close();
    removeFixture(fixture.root);
  }
});

it("a refusal preserves warm file-cache bytes and readiness preflight_data bytes", async () => {
  const fixture = createSingleClaimantFixture("quack-preflight-warm-store-");
  const primaryPath = fixture.claimantPaths[0];
  const task = parseTaskFile(fs.readFileSync(primaryPath, "utf-8"), primaryPath);
  configureMocks(task);
  const advisory = await runPreflight(task, makeAdapter(fixture.root, false), { force: true });
  const cachePath = path.join(fixture.root, ".quack", "prep", "TASK-100-preflight.json");
  const cacheBytesBefore = fs.readFileSync(cachePath);
  const db = new QuackDB(path.join(fixture.root, ".quack", "quack.db"));
  const dbBlobBefore = db.getReadinessSnapshot("TASK-100", advisory.contentHash)?.preflight_data;
  db.close();
  expect(dbBlobBefore).toBeTruthy();

  const crossPath = path.join(fixture.taskDir, "TASK-999-b.md");
  fs.writeFileSync(crossPath, taskSpec("TASK-100"), "utf-8");
  expect(await listDuplicateClaimants(fixture.taskDir, "TASK-100")).toEqual([
    "TASK-100-a.md",
    "TASK-999-b.md",
  ]);
  configureMocks(task);
  try {
    const refused = await runPreflight(task, makeAdapter(fixture.root, true), { force: true });
    expect((refused.decomposition as { refused?: unknown }).refused).toBeDefined();
    expect(fs.readFileSync(cachePath).equals(cacheBytesBefore)).toBe(true);
    const afterDb = new QuackDB(path.join(fixture.root, ".quack", "quack.db"));
    try {
      expect(afterDb.getReadinessSnapshot("TASK-100", advisory.contentHash)?.preflight_data).toBe(
        dbBlobBefore,
      );
    } finally {
      afterDb.close();
    }
  } finally {
    removeFixture(fixture.root);
  }
});
