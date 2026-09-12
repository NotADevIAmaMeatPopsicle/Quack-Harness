import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import type { AdapterConfig, GateResult, ParsedTask, TaskContext } from "../../src/core/types";
import { TASK_CREATION_LOCK_FILE } from "../../src/core/task-creation-reservation";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { PrepCache } from "../../src/monitor/prep-cache";
import { ReadinessService } from "../../src/monitor/readiness-service";
import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import {
  DecompositionFinalizeError,
  finalizeDecompositionTransaction as finalizeDecompositionOperation,
} from "../../src/preflight/decomposition-finalizer";
import {
  decompositionJournalPathForTask,
  listPendingDecompositionStatusProjections,
  recoverAndProjectPendingDecompositionTransactions as recoverAndProjectDecompositionOperation,
  withDecompositionAdmissionFence,
} from "../../src/preflight/decomposition-transaction-journal";
import type { SpecReviewResult } from "../../src/preflight/spec-review-types";
import { computeDecompositionParentHash } from "../../src/preflight/task-decomposer";

const mockRunReadinessGate = jest.fn<Promise<GateResult>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/gate/gate", () => ({
  runReadinessGate: (...args: [ParsedTask, ProjectAdapter]) => mockRunReadinessGate(...args),
}));

const mockGenerateBlueprint = jest.fn<Promise<Blueprint>, [ParsedTask, ProjectAdapter]>();
jest.mock("../../src/blueprint/blueprint-agent", () => ({
  generateBlueprint: (...args: [ParsedTask, ProjectAdapter]) => mockGenerateBlueprint(...args),
}));

const mockAssembleContext = jest.fn<Promise<TaskContext>, [ParsedTask, ProjectAdapter, string?]>();
jest.mock("../../src/dispatcher/context-assembler", () => ({
  assembleContext: (...args: [ParsedTask, ProjectAdapter, string?]) => mockAssembleContext(...args),
}));

const mockReviewSpecAmbiguity = jest.fn<Promise<SpecReviewResult>, [ParsedTask, unknown?]>();
mockReviewSpecAmbiguity.mockResolvedValue({
  ambiguityCount: 0,
  riskLevel: "low",
  findings: [],
  suggestedClarifications: [],
});
jest.mock("../../src/preflight/spec-reviewer", () => ({
  reviewSpecAmbiguity: (...args: [ParsedTask, unknown?]) => mockReviewSpecAmbiguity(...args),
}));

const mockDecomposeTask = jest.fn<
  Promise<DecompositionTopology>,
  [
    ParsedTask,
    ProjectAdapter,
    Blueprint,
    { maxSubtasks?: number; preferConfiguredProvider?: boolean }?,
  ]
>();
jest.mock("../../src/preflight/task-decomposer", () => {
  const actual = jest.requireActual<typeof import("../../src/preflight/task-decomposer")>(
    "../../src/preflight/task-decomposer",
  );
  return {
    ...actual,
    decomposeTask: (
      ...args: [
        ParsedTask,
        ProjectAdapter,
        Blueprint,
        { maxSubtasks?: number; preferConfiguredProvider?: boolean }?,
      ]
    ) => mockDecomposeTask(...args),
  };
});

const mockMaterializeChildDrafts = jest.fn<
  Promise<ChildDraft[]>,
  [DecompositionTopology, ParsedTask, ProjectAdapter, Blueprint]
>();
jest.mock("../../src/preflight/subtask-materializer", () => ({
  materializeChildDrafts: (
    ...args: [DecompositionTopology, ParsedTask, ProjectAdapter, Blueprint]
  ) => mockMaterializeChildDrafts(...args),
}));

import { runPreflight as runPreflightOperation } from "../../src/preflight/preflight-runner";

const REAL_GIT_CASE_TIMEOUT_MS = 30_000;
const registerTest = test;

interface DecompositionFixtureRun {
  root: string;
  adapter?: ProjectAdapter;
  settled: boolean;
  bodyPassed: boolean;
  completion: Promise<void>;
  record: (phase: string, details?: Record<string, unknown>) => void;
  preserve: (reason: string) => Promise<void>;
}

let activeFixture: DecompositionFixtureRun | undefined;

function createFixtureRun(root: string): DecompositionFixtureRun {
  const startedAt = Date.now();
  const testName = expect.getState().currentTestName;
  let evidenceDir: string | undefined;
  if (process.env.QUACK_DECOMPOSITION_DIAGNOSTICS === "1") {
    const parent = path.join(process.cwd(), ".dev", "decomposition-diagnostics");
    fsSync.mkdirSync(parent, { recursive: true });
    evidenceDir = fsSync.mkdtempSync(path.join(parent, "run-"));
  }
  let captureFailed = false;
  const record = (phase: string, details: Record<string, unknown> = {}): void => {
    if (!evidenceDir || captureFailed) return;
    try {
      const fd = fsSync.openSync(path.join(evidenceDir, "phases.jsonl"), "a", 0o600);
      try {
        fsSync.writeSync(
          fd,
          JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, ...details }) + "\n",
        );
        fsSync.fsyncSync(fd);
      } finally {
        fsSync.closeSync(fd);
      }
    } catch (error) {
      captureFailed = true;
      console.warn("Decomposition fixture phase capture failed", error);
    }
  };
  let preserved = false;
  const preserve = async (reason: string): Promise<void> => {
    if (preserved) return;
    preserved = true;
    record("fixture.preserved", { reason, root, testName });
    console.warn("Preserved decomposition fixture", { reason, root, testName, evidenceDir });
    if (evidenceDir) {
      try {
        // Best-effort observation before joining late work. Never follow fixture links.
        await fs.cp(root, path.join(evidenceDir, "failure-snapshot"), {
          recursive: true,
          dereference: false,
        });
      } catch (error) {
        console.warn("Decomposition fixture snapshot failed; original root retained", error);
      }
    }
  };
  record("fixture.created", { root, testName, timeoutMs: REAL_GIT_CASE_TIMEOUT_MS });
  return {
    root,
    settled: true,
    bodyPassed: false,
    completion: Promise.resolve(),
    record,
    preserve,
  };
}

function ownFixtureWork<T>(
  fixture: DecompositionFixtureRun,
  phase: "setup" | "body",
  work: () => Promise<T>,
): Promise<T> {
  fixture.settled = false;
  fixture.record(`${phase}.started`);
  const pending = Promise.resolve()
    .then(work)
    .then(
      (result) => {
        if (phase === "body") fixture.bodyPassed = true;
        fixture.record(`${phase}.completed`);
        return result;
      },
      (error: unknown) => {
        fixture.record(`${phase}.failed`, { error: String(error) });
        throw error;
      },
    )
    .finally(() => {
      fixture.settled = true;
    });
  // Observe rejection as well as fulfillment; the original promise still fails Jest.
  fixture.completion = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function ownCase(work: () => Promise<void>): Promise<void> {
  if (!activeFixture) return Promise.reject(new Error("Missing decomposition fixture"));
  return ownFixtureWork(activeFixture, "body", work);
}

async function joinFixture(fixture: DecompositionFixtureRun): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fixture.completion.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), REAL_GIT_CASE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

async function observeFixtureOperation<T>(label: string, work: () => Promise<T>): Promise<T> {
  const fixture = activeFixture;
  fixture?.record(`${label}.started`);
  try {
    const result = await work();
    fixture?.record(`${label}.completed`);
    return result;
  } catch (error) {
    fixture?.record(`${label}.failed`, { error: String(error) });
    throw error;
  }
}

const runPreflight = (...args: Parameters<typeof runPreflightOperation>) =>
  observeFixtureOperation("preflight", () => runPreflightOperation(...args));
const finalizeDecompositionTransaction = (
  ...args: Parameters<typeof finalizeDecompositionOperation>
) => observeFixtureOperation("finalize", () => finalizeDecompositionOperation(...args));
const recoverAndProjectPendingDecompositionTransactions = (
  ...args: Parameters<typeof recoverAndProjectDecompositionOperation>
) =>
  observeFixtureOperation("recover-and-project", () =>
    recoverAndProjectDecompositionOperation(...args),
  );

function parentMarkdown(): string {
  return [
    "# TASK-006: Browser smoke harness",
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 6-8 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** smoke, browser",
    "",
    "## Problem Statement",
    "The demo needs a reproducible browser smoke harness that proves runtime behavior through a served HTTP fixture.",
    "",
    "## Current State",
    "The package scripts and browser fixture have not yet been connected into one repeatable check.",
    "",
    "## Recommended Approach",
    "Configure the runtime first, then execute a served browser fixture whose module import uses an HTTP base URL.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `package.json, package-lock.json` | Modify | Add the smoke runtime |",
    "| `tests/smoke/fixtures/* (if used)` | Create | Browser import fixture |",
    "",
    "## Success Criteria",
    "- [ ] The smoke command installs reproducibly",
    "- [ ] The browser fixture resolves from an HTTP base URL",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the command in a clean checkout",
    "- [ ] Exercise the browser import over HTTP",
    "",
    "## Anti-Patterns",
    "- Do not resolve browser imports against about:blank",
    "",
    "## Context References",
    "- package.json",
    "",
  ].join("\n");
}

function readyChild(
  subtaskId: string,
  title: string,
  filePath: string,
  action: "Create" | "Modify" | "Delete" | "Reference",
  criterion: string,
  dependsOn: string[] = [],
): ChildDraft {
  const markdown = [
    `# ${subtaskId}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 2-3 hours",
    "- **Status:** READY",
    `- **Blocked By:** [${dependsOn.join(", ")}]`,
    "- **Blocks:** []",
    "- **Tags:** smoke, browser, subtask",
    "",
    "## Problem Statement",
    `This child delivers ${title.toLowerCase()} with enough concrete implementation detail to remain independently testable and reviewable.`,
    "",
    "## Current State",
    `The owned path ${filePath} does not yet satisfy its assigned browser smoke requirement.`,
    "",
    "## Recommended Approach",
    `Implement the assigned behavior in ${filePath}, preserving the parent contract and checking the concrete runtime result.`,
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    `| \`${filePath}\` | ${action} | Complete the assigned smoke-harness scope |`,
    "",
    "## Success Criteria",
    `- [ ] ${criterion}`,
    "",
    "## Testing Requirements",
    "- [ ] Verify the owned behavior succeeds from a clean checkout",
    "- [ ] Verify the owned behavior reports an actionable failure when misconfigured",
    "",
    "## Anti-Patterns",
    "- Do not replace the runtime assertion with a source-text-only check",
    "- Do not widen this child beyond its owned path and criterion",
    "",
    "## Context References",
    "- Parent task: TASK-006",
    ...dependsOn.map((dependency) => `- Sibling dependency: ${dependency}`),
    "",
  ].join("\n");

  return {
    subtaskId,
    title,
    markdown,
    sectionsPresent: [],
    prepScore: 5,
    prepReady: true,
    deficiencies: [],
  };
}

function fullTopology(task: ParsedTask): DecompositionTopology {
  return {
    parentTaskId: task.id,
    parentContentHash: computeDecompositionParentHash(task.rawContent),
    subtasks: [
      {
        id: "TASK-006-A",
        title: "Configure smoke runtime",
        filesToModify: [task.filesToModify[0]],
        successCriteria: [task.successCriteria[0]],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-006-B",
        title: "Verify browser fixture",
        filesToModify: [task.filesToModify[1]],
        successCriteria: [task.successCriteria[1]],
        dependsOn: ["TASK-006-A"],
        isFinal: true,
      },
    ],
    coverageReport: {
      fileOwnership: [],
      criterionOwnership: [],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      hasCoverageGap: false,
    },
  };
}

function makeAdapter(root: string): ProjectAdapter {
  const config = {
    version: "1.0",
    project: {
      name: "auto-decompose-quality",
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
      autoDecompose: { enabled: true, maxSubtasks: 4, writeSpecs: true },
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
      sharedHash: "auto-decompose-quality",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function git(root: string, args: string[]): string {
  const fixture = activeFixture?.root === root ? activeFixture : undefined;
  fixture?.record("fixture.git.started", { args });
  try {
    const result = execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    fixture?.record("fixture.git.completed", { args });
    return result;
  } catch (error) {
    fixture?.record("fixture.git.failed", { args, error: String(error) });
    throw error;
  }
}

describe("auto-decomposition write safety", () => {
  let root: string;
  let parentPath: string;
  let task: ParsedTask;
  let adapter: ProjectAdapter;
  let topology: DecompositionTopology;
  let drafts: ChildDraft[];
  let initialHead: string;
  let fixtureAdmissionRefused = false;
  // These cases perform real local Git transactions; keep their budget local.
  const test = (name: string, work: () => Promise<void>): void => {
    registerTest(name, () => ownCase(work), REAL_GIT_CASE_TIMEOUT_MS);
  };

  beforeEach(() => {
    fixtureAdmissionRefused = Boolean(activeFixture && !activeFixture.settled);
    if (fixtureAdmissionRefused) {
      throw new Error(
        "Previous decomposition fixture is still running; refusing to reset shared state",
      );
    }
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "quack-auto-decompose-quality-"));
    const fixture = createFixtureRun(root);
    activeFixture = fixture;
    return ownFixtureWork(fixture, "setup", async () => {
      const taskDir = path.join(root, "docs", "tasks");
      await fs.mkdir(taskDir, { recursive: true });
      parentPath = path.join(taskDir, "TASK-006-browser-smoke-harness.md");
      const content = parentMarkdown();
      await fs.writeFile(parentPath, content, "utf-8");
      task = parseTaskFile(content, parentPath);
      adapter = makeAdapter(root);
      fixture.adapter = adapter;
      topology = fullTopology(task);
      drafts = [
        readyChild(
          "TASK-006-A",
          "Configure smoke runtime",
          task.filesToModify[0].path,
          task.filesToModify[0].action,
          task.successCriteria[0],
        ),
        readyChild(
          "TASK-006-B",
          "Verify browser fixture",
          task.filesToModify[1].path,
          task.filesToModify[1].action,
          task.successCriteria[1],
          ["TASK-006-A"],
        ),
      ];

      git(root, ["init", "-q", "-b", "main"]);
      git(root, ["config", "user.email", "quack-test@example.com"]);
      git(root, ["config", "user.name", "Quack Test"]);
      git(root, ["config", "commit.gpgsign", "false"]);
      git(root, ["add", "docs/tasks"]);
      git(root, ["commit", "-q", "-m", "fixture"]);
      initialHead = git(root, ["rev-parse", "HEAD"]);

      mockRunReadinessGate.mockReset();
      mockGenerateBlueprint.mockReset();
      mockAssembleContext.mockReset();
      mockReviewSpecAmbiguity.mockClear();
      mockDecomposeTask.mockReset();
      mockMaterializeChildDrafts.mockReset();

      mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task });
      mockGenerateBlueprint.mockResolvedValue({
        taskId: task.id,
        fileAnalyses: task.filesToModify.map((file) => ({
          filePath: file.path,
          action: file.action,
          currentStructure: "fixture",
          integrationPoints: "browser smoke harness",
          patternToFollow: "served fixture",
        })),
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      });
      mockAssembleContext.mockResolvedValue({
        taskSpec: task.rawContent,
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
      });
      mockDecomposeTask.mockResolvedValue(topology);
      mockMaterializeChildDrafts.mockResolvedValue(drafts);
    });
  }, REAL_GIT_CASE_TIMEOUT_MS);

  afterEach(async () => {
    if (fixtureAdmissionRefused || !activeFixture) return;
    const fixture = activeFixture;
    // Snapshot before joining: a timed-out body may still be mutating its fixture.
    const preserve = !fixture.bodyPassed;
    if (preserve) await fixture.preserve("failed_or_unfinished_before_teardown");
    if (!(await joinFixture(fixture))) {
      await fixture.preserve("body_did_not_settle_before_cleanup_deadline");
      throw new Error(`Decomposition fixture is still running; retained at ${fixture.root}`);
    }
    if (preserve) return;
    try {
      await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fixture.record("fixture.cleaned");
    } catch (error) {
      await fixture.preserve("cleanup_failed_after_settlement");
      throw error;
    }
  }, REAL_GIT_CASE_TIMEOUT_MS + 5_000);

  test("fails closed on grouped-path coverage gaps before materialization or writes", async () => {
    topology.subtasks[0].filesToModify = [
      { path: "package.json", action: "Modify", notes: "split from grouped row" },
    ];
    mockDecomposeTask.mockResolvedValue(topology);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "coverage_gap",
      unmappedFiles: ["package.json, package-lock.json"],
      unexpectedFiles: ["package.json"],
    });
    expect(mockMaterializeChildDrafts).not.toHaveBeenCalled();
    expect(await fs.readdir(path.dirname(parentPath))).toEqual([
      "TASK-006-browser-smoke-harness.md",
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    const cached = await new PrepCache(root).readPreflight(task.id, result.contentHash);
    expect(cached?.decomposition?.refused?.errorType).toBe("coverage_gap");
  });

  test("re-gates provider drafts and refuses low-quality children without writing specs", async () => {
    mockMaterializeChildDrafts.mockResolvedValue(
      drafts.map((draft) => ({
        ...draft,
        markdown: `# ${draft.subtaskId}: ${draft.title}`,
        prepReady: true,
        prepScore: 5,
      })),
    );

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "child_quality",
    });
    expect(await fs.readdir(path.dirname(parentPath))).toEqual([
      "TASK-006-browser-smoke-harness.md",
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    const cached = await new PrepCache(root).readPreflight(task.id, result.contentHash);
    expect(cached?.decomposition?.refused?.errorType).toBe("child_quality");
  });

  registerTest.each([
    [
      "a missing Anti-Patterns section",
      (markdown: string) =>
        markdown.replace(/^## Anti-Patterns[\s\S]*?(?=^## Context References)/m, ""),
    ],
    [
      "the generic decomposition stub",
      (markdown: string) => `${markdown}\nThis subtask is part of TASK-006 decomposition.\n`,
    ],
    ["the file-count testing stub", (markdown: string) => `${markdown}\nAt least 4×2 new tests\n`],
    [
      "the generic blueprint approach stub",
      (markdown: string) =>
        `${markdown}\nFollow the implementation patterns from the parent task's blueprint.\n`,
    ],
    [
      "the generic parent-state stub",
      (markdown: string) =>
        `${markdown}\nParent task TASK-006 was decomposed into multiple subtasks.\n`,
    ],
  ] as const)(
    "refuses forged ready metadata when the draft contains %s",
    (_label, mutate) =>
      ownCase(async () => {
        mockMaterializeChildDrafts.mockResolvedValue([
          { ...drafts[0], markdown: mutate(drafts[0].markdown), prepScore: 5, prepReady: true },
          drafts[1],
        ]);

        const result = await runPreflight(task, adapter, { force: true });

        expect(result.decomposition?.refused).toMatchObject({ errorType: "child_quality" });
        expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
        expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
      }),
    REAL_GIT_CASE_TIMEOUT_MS,
  );

  test("retains the materializer provider error in child-quality diagnostics", async () => {
    mockMaterializeChildDrafts.mockResolvedValue([
      {
        ...drafts[0],
        markdown: "",
        prepReady: false,
        prepScore: 0,
        deficiencies: ["Materialization failed: provider unavailable"],
        parseError: "provider unavailable",
      },
      drafts[1],
    ]);

    const result = await runPreflight(task, adapter, { force: true });
    const refusal = result.decomposition?.refused;
    expect(refusal?.errorType).toBe("child_quality");
    if (refusal?.errorType !== "child_quality") throw new Error("expected child refusal");
    expect(refusal.drafts[0]).toMatchObject({
      subtaskId: "TASK-006-A",
      parseError: "provider unavailable",
    });
    expect(refusal.drafts[0].deficiencies).toContain(
      "Materialization failed: provider unavailable",
    );
  });

  registerTest.each([
    [
      "terminal status",
      (draft: ChildDraft) => ({
        ...draft,
        markdown: draft.markdown.replace("- **Status:** READY", "- **Status:** COMPLETE"),
      }),
    ],
    [
      "extra success criterion",
      (draft: ChildDraft) => ({
        ...draft,
        markdown: draft.markdown.replace(
          "## Testing Requirements",
          "- [ ] Provider-added behavior outside the topology\n\n## Testing Requirements",
        ),
      }),
    ],
  ] as const)(
    "refuses a high-scoring child with %s",
    (_label, mutate) =>
      ownCase(async () => {
        mockMaterializeChildDrafts.mockResolvedValue([mutate(drafts[0]), drafts[1]]);

        const result = await runPreflight(task, adapter, { force: true });
        const refusal = result.decomposition?.refused;
        expect(refusal?.errorType).toBe("child_quality");
        if (refusal?.errorType !== "child_quality") throw new Error("expected child refusal");
        expect(refusal.drafts[0].deficiencies.join("\n")).toMatch(
          /status must be READY|Unexpected assigned criteria/,
        );
        expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
      }),
    REAL_GIT_CASE_TIMEOUT_MS,
  );

  test("rejects duplicate criterion ownership before materialization", async () => {
    topology.subtasks[1].successCriteria.push(task.successCriteria[0]);
    mockDecomposeTask.mockResolvedValue(topology);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "coverage_gap",
      duplicatedCriteria: [task.successCriteria[0]],
    });
    expect(mockMaterializeChildDrafts).not.toHaveBeenCalled();
  });

  test("allows the final verification marker only on the final child", async () => {
    topology.subtasks[0].successCriteria.push("All parent task success criteria verified");
    mockDecomposeTask.mockResolvedValue(topology);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "coverage_gap",
      unexpectedCriteria: ["All parent task success criteria verified"],
    });
    expect(mockMaterializeChildDrafts).not.toHaveBeenCalled();
  });

  test("accepts the final verification marker on the sole final child", async () => {
    const marker = "All parent task success criteria verified";
    topology.subtasks[1].successCriteria.push(marker);
    drafts[1] = {
      ...drafts[1],
      markdown: drafts[1].markdown.replace(
        "## Testing Requirements",
        `- [ ] ${marker}\n\n## Testing Requirements`,
      ),
    };
    mockDecomposeTask.mockResolvedValue(topology);
    mockMaterializeChildDrafts.mockResolvedValue(drafts);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.decomposed).toBe(true);
  });

  test("rejects a forged topology without exactly one trailing final child", async () => {
    topology.subtasks[0].isFinal = true;
    mockDecomposeTask.mockResolvedValue(topology);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({ errorType: "invalid_plan" });
    expect(mockMaterializeChildDrafts).not.toHaveBeenCalled();
  });

  test("refuses high-scoring drafts whose files, criteria, or dependencies drift from topology", async () => {
    const drifted = {
      ...drafts[1],
      markdown: drafts[1].markdown
        .replace("| Create |", "| Modify |")
        .replace("- **Blocked By:** [TASK-006-A]", "- **Blocked By:** []")
        .replace(
          `- [ ] ${task.successCriteria[1]}`,
          "- [ ] A different unassigned criterion succeeds",
        ),
    };
    mockMaterializeChildDrafts.mockResolvedValue([drafts[0], drifted]);

    const result = await runPreflight(task, adapter, { force: true });

    const refusal = result.decomposition?.refused;
    expect(refusal?.errorType).toBe("child_quality");
    if (refusal?.errorType !== "child_quality") {
      throw new Error("Expected a child-quality refusal");
    }
    expect(refusal.drafts).toHaveLength(1);
    expect(refusal.drafts[0].subtaskId).toBe("TASK-006-B");
    expect(refusal.drafts[0].prepScore).toBe(5);
    expect(refusal.drafts[0].deficiencies.join("\n")).toMatch(/Action mismatch/);
    expect(refusal.drafts[0].deficiencies.join("\n")).toMatch(/Missing assigned criteria/);
    expect(refusal.drafts[0].deficiencies.join("\n")).toMatch(/Blocked By mismatch/);
    expect(await fs.readdir(path.dirname(parentPath))).toEqual([
      "TASK-006-browser-smoke-harness.md",
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("refuses parent drift after materialization and before any child write", async () => {
    mockMaterializeChildDrafts.mockImplementation(async () => {
      await fs.writeFile(parentPath, `${task.rawContent}\n<!-- operator edit -->\n`, "utf-8");
      return drafts;
    });

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "parent_spec_changed",
    });
    expect(await fs.readdir(path.dirname(parentPath))).toEqual([
      "TASK-006-browser-smoke-harness.md",
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("operator edit");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("refuses a second parent claimant created during materialization", async () => {
    const duplicatePath = path.join(path.dirname(parentPath), "TASK-999-claims-parent.md");
    mockMaterializeChildDrafts.mockImplementation(async () => {
      await fs.writeFile(duplicatePath, task.rawContent, "utf-8");
      return drafts;
    });

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "duplicate_claimants",
    });
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(
      (await fs.readdir(path.dirname(parentPath))).filter((name) => /^TASK-006-[A-Z]-/.test(name)),
    ).toEqual([]);
  });

  test("refuses a pre-staged parent before writes and preserves its exact index entry", async () => {
    const stagedParent = task.rawContent.replace("Browser smoke harness", "Staged operator title");
    await fs.writeFile(parentPath, stagedParent, "utf-8");
    git(root, ["add", "--", "docs/tasks/TASK-006-browser-smoke-harness.md"]);
    await fs.writeFile(parentPath, task.rawContent, "utf-8");
    const stagedBefore = git(root, ["show", ":docs/tasks/TASK-006-browser-smoke-harness.md"]);

    const result = await runPreflight(task, adapter, { force: true });

    const refusal = result.decomposition?.refused;
    expect(refusal?.errorType).toBe("write_failed");
    if (refusal?.errorType !== "write_failed") throw new Error("expected write refusal");
    expect(refusal.message).toContain("staged changes");
    expect(git(root, ["show", ":docs/tasks/TASK-006-browser-smoke-harness.md"])).toBe(stagedBefore);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("rolls back a destination conflict, records refusal, and succeeds on retry", async () => {
    const conflictPath = path.join(
      path.dirname(parentPath),
      "TASK-006-A-configure-smoke-runtime.md",
    );
    await fs.writeFile(conflictPath, "conflicting operator file\n", "utf-8");

    const refused = await runPreflight(task, adapter, { force: true });
    expect(refused.decomposition?.refused).toMatchObject({ errorType: "write_failed" });
    expect(await fs.readFile(conflictPath, "utf-8")).toBe("conflicting operator file\n");
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    const cached = await new PrepCache(root).readPreflight(task.id, refused.contentHash);
    expect(cached?.decomposition?.refused?.errorType).toBe("write_failed");

    await fs.unlink(conflictPath);
    const retried = await runPreflight(task, adapter, { force: true });
    expect(retried.decomposition?.decomposed).toBe(true);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
  });

  test("commits the exact parent and ready children as one tracker transaction", async () => {
    const result = await runPreflight(task, adapter, { force: true });

    expect(mockDecomposeTask).toHaveBeenCalledWith(
      task,
      adapter,
      expect.any(Object),
      expect.objectContaining({ preferConfiguredProvider: true }),
    );
    expect(result.decomposition).toMatchObject({
      decomposed: true,
      subtaskIds: ["TASK-006-A", "TASK-006-B"],
    });
    const parentAfter = await fs.readFile(parentPath, "utf-8");
    expect(parentAfter).toContain("**Status:** DECOMPOSED");
    expect(parentAfter).toContain("**Blocks:** [TASK-006-A, TASK-006-B]");
    expect(parentAfter).toContain("## Decomposition Summary");
    expect(parentAfter).toContain(
      "| `TASK-006-B` | Verify browser fixture | TASK-006-A | prep 5 |",
    );

    const committedPaths = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"])
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();
    expect(committedPaths).toEqual([
      "docs/tasks/TASK-006-A-configure-smoke-runtime.md",
      "docs/tasks/TASK-006-B-verify-browser-fixture.md",
      "docs/tasks/TASK-006-browser-smoke-harness.md",
    ]);
    expect(git(root, ["log", "-1", "--format=%s"])).toBe(
      "docs(tasks): auto-commit subtasks for TASK-006",
    );
    const committedCache = await new PrepCache(root).readPreflight(
      task.id,
      computeDecompositionParentHash(parentAfter),
    );
    expect(committedCache).toMatchObject({ decomposition: { decomposed: true } });
    expect(committedCache?.contentHash).toBe(computeDecompositionParentHash(parentAfter));
  });

  test("rolls back parent and children when the path-limited commit is rejected", async () => {
    const unrelatedPath = path.join(root, "operator-notes.txt");
    await fs.writeFile(unrelatedPath, "keep staged\n", "utf-8");
    git(root, ["add", "--", "operator-notes.txt"]);
    const unrelatedIndexBefore = git(root, ["show", ":operator-notes.txt"]);
    const refLockPath = path.join(root, ".git", "refs", "heads", "main.lock");
    await fs.writeFile(refLockPath, "block update-ref\n", "utf-8");

    const result = await runPreflight(task, adapter, { force: true });
    await fs.unlink(refLockPath);

    expect(result.decomposition?.refused).toMatchObject({
      errorType: "write_failed",
      rollbackErrors: [],
    });
    expect(await fs.readdir(path.dirname(parentPath))).toEqual([
      "TASK-006-browser-smoke-harness.md",
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("operator-notes.txt");
    expect(git(root, ["show", ":operator-notes.txt"])).toBe(unrelatedIndexBefore);
  });

  test("ignores event-sink failures after the decomposition commit succeeds", async () => {
    const emit = jest.fn(
      (
        stage: Parameters<IEventWriter["emit"]>[0],
        payload: Parameters<IEventWriter["emit"]>[1],
      ) => {
        if (
          stage === "preflight_auto_decompose_specs_committed" ||
          stage === "preflight_auto_decompose_complete" ||
          (stage === "stage_completed" &&
            (payload as unknown as { stage?: string }).stage === "decompose") ||
          stage === "preflight_complete"
        ) {
          throw new Error("event sink unavailable");
        }
      },
    );
    const events: IEventWriter = {
      sessionId: "event-failure-test",
      taskId: task.id,
      project: "auto-decompose-quality",
      recordSession: jest.fn(),
      emit,
    };

    const result = await runPreflight(task, adapter, { force: true, events });

    expect(result.decomposition?.decomposed).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    expect(emit).not.toHaveBeenCalledWith("preflight_auto_decompose_failed", expect.anything());
  });

  test("ignores stage, cache, database, and close observer failures after commit", async () => {
    const cacheWrite = jest
      .spyOn(PrepCache.prototype, "writePreflight")
      .mockRejectedValue(new Error("cache unavailable"));
    const readinessWrite = jest
      .spyOn(ReadinessService.prototype, "persistPreflightResult")
      .mockImplementation(() => {
        throw new Error("database unavailable");
      });
    const readinessClose = jest
      .spyOn(ReadinessService.prototype, "close")
      .mockImplementation(() => {
        throw new Error("database close unavailable");
      });
    const stageReporter = {
      started: jest.fn(),
      heartbeat: jest.fn(),
      completed: jest.fn((stage: string) => {
        if (stage === "decompose") throw new Error("stage projection unavailable");
      }),
      failed: jest.fn(),
    };
    try {
      const result = await runPreflight(task, adapter, {
        force: true,
        stageReporter,
        stageHeartbeatIntervalMs: 0,
      });

      expect(result.decomposition?.decomposed).toBe(true);
      expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
      expect(stageReporter.failed).not.toHaveBeenCalled();
    } finally {
      cacheWrite.mockRestore();
      readinessWrite.mockRestore();
      readinessClose.mockRestore();
    }
  });

  test("keeps a successful commit authoritative when reservation release fails", async () => {
    const hookPath = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(
      hookPath,
      "#!/bin/sh\nprintf 'not-json\\n' > docs/tasks/.task-creation.lock\nexit 0\n",
      "utf-8",
    );
    await fs.chmod(hookPath, 0o755);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.decomposed).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
  });

  test("does not execute repository commit hooks while creating the exact tree", async () => {
    const hookPath = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf-8");
    await fs.chmod(hookPath, 0o755);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.decomposed).toBe(true);
    expect(git(root, ["log", "-1", "--format=%s"])).toBe(
      "docs(tasks): auto-commit subtasks for TASK-006",
    );
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("returns finalized success after an irreversible post-CAS fault", async () => {
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask: task,
      parentFilePath: parentPath,
      parentContent: task.rawContent,
      topology,
      drafts,
      commitOptions: {
        afterPostCommitStep: (step) => {
          if (step === "ref_updated") throw new Error("synthetic post-CAS observer failure");
        },
      },
    });

    expect(finalized.commit).toMatchObject({ committed: true, journalReconciled: true });
    expect(finalized.warnings).toEqual([
      expect.stringContaining("synthetic post-CAS observer failure"),
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("recognizes an update-ref failure after the exact ref was published", async () => {
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask: task,
      parentFilePath: parentPath,
      parentContent: task.rawContent,
      topology,
      drafts,
      commitOptions: {
        executeRefUpdate: (projectRoot, args) => {
          execFileSync("git", [...args], { cwd: projectRoot });
          throw new Error("synthetic update-ref failure after ref publication");
        },
      },
    });

    expect(finalized.commit).toMatchObject({
      committed: true,
      journalReconciled: true,
      recoveryPending: true,
    });
    expect(finalized.commit.statusProjectionId).toMatch(/^[0-9a-f]{64}$/);
    expect(finalized.warnings).toEqual([
      expect.stringContaining("synthetic update-ref failure after ref publication"),
    ]);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
    expect(await listPendingDecompositionStatusProjections(adapter)).toEqual([
      expect.objectContaining({
        parentTaskId: task.id,
        projectionId: finalized.commit.statusProjectionId,
      }),
    ]);

    let projected: { status: string; updated_by: string } | undefined;
    const statusWrites = jest.fn((_: string, status: string, updatedBy: string) => {
      projected = { status, updated_by: updatedBy };
    });
    const store = {
      getStatus: () => projected,
      setStatus: statusWrites,
    };
    await expect(
      recoverAndProjectPendingDecompositionTransactions(adapter, store),
    ).resolves.toMatchObject({
      recoveries: [],
      projections: [
        {
          parentTaskId: task.id,
          projectionId: finalized.commit.statusProjectionId,
          outcome: "projected",
        },
      ],
    });
    await expect(
      recoverAndProjectPendingDecompositionTransactions(adapter, store),
    ).resolves.toEqual({ recoveries: [], projections: [] });
    expect(statusWrites).toHaveBeenCalledTimes(1);
  });

  test("keeps a confirmed failed ref compare-and-swap retryable only after rollback", async () => {
    await expect(
      finalizeDecompositionTransaction({
        adapter,
        parentTask: task,
        parentFilePath: parentPath,
        parentContent: task.rawContent,
        topology,
        drafts,
        commitOptions: {
          executeRefUpdate: () => {
            throw new Error("synthetic update-ref refusal before publication");
          },
        },
      }),
    ).rejects.toMatchObject<Partial<DecompositionFinalizeError>>({ kind: "write_failed" });

    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(
      (await fs.readdir(path.dirname(parentPath))).filter((name) => /^TASK-006-[A-Z]-/.test(name)),
    ).toEqual([]);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("recognizes the exact journal transaction when the published ref advances before update-ref reports failure", async () => {
    let transactionCommit = "";
    let descendantCommit = "";
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask: task,
      parentFilePath: parentPath,
      parentContent: task.rawContent,
      topology,
      drafts,
      commitOptions: {
        executeRefUpdate: (projectRoot, args) => {
          execFileSync("git", [...args], { cwd: projectRoot });
          transactionCommit = git(projectRoot, ["rev-parse", "HEAD"]);
          const transactionTree = git(projectRoot, ["rev-parse", `${transactionCommit}^{tree}`]);
          descendantCommit = git(projectRoot, [
            "commit-tree",
            transactionTree,
            "-p",
            transactionCommit,
            "-m",
            "concurrent descendant",
          ]);
          git(projectRoot, ["update-ref", "refs/heads/main", descendantCommit, transactionCommit]);
          throw new Error("synthetic update-ref failure after descendant advance");
        },
      },
    });

    expect(finalized.commit).toMatchObject({
      committed: true,
      sha: transactionCommit.slice(0, 7),
      journalReconciled: true,
      recoveryPending: true,
    });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(descendantCommit);
    expect(git(root, ["merge-base", transactionCommit, descendantCommit])).toBe(transactionCommit);
    expect(await fs.readFile(parentPath, "utf-8")).toContain("**Status:** DECOMPOSED");
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("reconciles a published transaction when the first ref observation is unavailable", async () => {
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask: task,
      parentFilePath: parentPath,
      parentContent: task.rawContent,
      topology,
      drafts,
      commitOptions: {
        executeRefUpdate: (projectRoot, args) => {
          execFileSync("git", [...args], { cwd: projectRoot });
          throw new Error("synthetic update-ref transport failure");
        },
        readRefPublicationGit: () =>
          Promise.reject(new Error("synthetic ref observation unavailable")),
      },
    });

    expect(finalized.commit).toMatchObject({
      committed: true,
      journalReconciled: true,
      recoveryPending: true,
    });
    expect(finalized.warnings).toEqual([
      expect.stringContaining("synthetic update-ref transport failure"),
    ]);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("reports an unobservable unreconciled ref update as non-retryable without claiming commit", async () => {
    let refusal: unknown;
    try {
      await finalizeDecompositionTransaction({
        adapter,
        parentTask: task,
        parentFilePath: parentPath,
        parentContent: task.rawContent,
        topology,
        drafts,
        commitOptions: {
          executeRefUpdate: async (projectRoot, args) => {
            execFileSync("git", [...args], { cwd: projectRoot });
            await fs.writeFile(
              parentPath,
              `${task.rawContent}\n<!-- blocks immediate recovery -->\n`,
              "utf-8",
            );
            throw new Error("synthetic update-ref transport failure");
          },
          readRefPublicationGit: () =>
            Promise.reject(new Error("synthetic ref observation unavailable")),
        },
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(DecompositionFinalizeError);
    const typedRefusal = refusal as DecompositionFinalizeError;
    expect(typedRefusal.kind).toBe("commit_indeterminate");
    expect(typedRefusal.details).toMatchObject({
      commitState: "unknown",
      recoveryPending: true,
      retryable: false,
    });

    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).resolves.toBeUndefined();
  });

  test("returns committed recovery-pending after post-CAS recovery fails and converges exactly once", async () => {
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask: task,
      parentFilePath: parentPath,
      parentContent: task.rawContent,
      topology,
      drafts,
      commitOptions: {
        afterPostCommitStep: async (step) => {
          if (step !== "ref_updated") return;
          await fs.writeFile(
            parentPath,
            `${task.rawContent}\n<!-- divergent after CAS -->\n`,
            "utf-8",
          );
          throw new Error("synthetic post-CAS failure with blocked recovery");
        },
      },
    });

    expect(finalized.commit).toMatchObject({
      committed: true,
      recoveryPending: true,
      journalReconciled: false,
    });
    expect(finalized.warnings).toEqual([
      expect.stringContaining("journal retained and scheduling remains fenced"),
      expect.stringContaining("synthetic post-CAS failure with blocked recovery"),
    ]);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).resolves.toBeUndefined();

    let dispatchStarted = false;
    const statusWrites: Array<{ taskId: string; status: string; updatedBy: string }> = [];
    let storedStatus: { status: string; updated_by: string } | undefined;
    const store = {
      getStatus: () => storedStatus,
      setStatus: (taskId: string, status: string, updatedBy: string) => {
        statusWrites.push({ taskId, status, updatedBy });
        storedStatus = { status, updated_by: updatedBy };
      },
    };
    await expect(
      withDecompositionAdmissionFence(
        adapter,
        "TASK-006-A",
        () => {
          dispatchStarted = true;
        },
        store,
      ),
    ).rejects.toThrow("Parent bytes diverged");
    expect(dispatchStarted).toBe(false);

    await fs.writeFile(parentPath, finalized.parentContent, "utf-8");
    await expect(
      withDecompositionAdmissionFence(adapter, "TASK-006-A", () => {
        dispatchStarted = true;
      }),
    ).rejects.toThrow("monitor status store");
    expect(dispatchStarted).toBe(false);
    expect(statusWrites).toHaveLength(0);
    expect(await listPendingDecompositionStatusProjections(adapter)).toHaveLength(1);

    await expect(
      recoverAndProjectPendingDecompositionTransactions(
        adapter,
        store,
        {},
        {
          afterProjection: () => {
            throw new Error("synthetic crash after authoritative projection");
          },
        },
      ),
    ).rejects.toThrow("synthetic crash after authoritative projection");
    expect(statusWrites).toHaveLength(1);
    expect(await listPendingDecompositionStatusProjections(adapter)).toHaveLength(1);

    const recovered = await recoverAndProjectPendingDecompositionTransactions(adapter, store);
    expect(recovered.recoveries).toEqual([]);
    expect(recovered.projections).toEqual([
      expect.objectContaining({
        parentTaskId: task.id,
        outcome: "already_projected",
        status: "DECOMPOSED",
      }),
    ]);
    expect(statusWrites).toHaveLength(1);
    expect(await listPendingDecompositionStatusProjections(adapter)).toEqual([]);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, task.id)),
    ).rejects.toThrow();
  });

  test("types real task-creation reservation contention and writes nothing", async () => {
    const lockPath = path.join(path.dirname(parentPath), TASK_CREATION_LOCK_FILE);
    await fs.writeFile(lockPath, "fresh reservation\n", "utf-8");

    await expect(
      finalizeDecompositionTransaction({
        adapter,
        parentTask: task,
        parentFilePath: parentPath,
        parentContent: task.rawContent,
        topology,
        drafts,
        reservationOptions: { timeoutMs: 25, retryMs: 5, staleMs: 60_000 },
      }),
    ).rejects.toMatchObject<Partial<DecompositionFinalizeError>>({ kind: "write_locked" });
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(
      (await fs.readdir(path.dirname(parentPath))).filter((name) => /^TASK-006-[A-Z]-/.test(name)),
    ).toEqual([]);
  });

  test("finalization enforces the adapter-capped maximum carried by the plan", async () => {
    const oversizedTopology: DecompositionTopology = {
      ...topology,
      maxSubtasks: 2,
      subtasks: [
        topology.subtasks[0],
        { ...topology.subtasks[1], isFinal: false },
        {
          ...topology.subtasks[1],
          id: "TASK-006-C",
          dependsOn: ["TASK-006-A", "TASK-006-B"],
          isFinal: true,
        },
      ],
    };

    await expect(
      finalizeDecompositionTransaction({
        adapter,
        parentTask: task,
        parentFilePath: parentPath,
        parentContent: task.rawContent,
        topology: oversizedTopology,
        drafts,
      }),
    ).rejects.toMatchObject<Partial<DecompositionFinalizeError>>({ kind: "invalid_plan" });
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("commits an exact tracked-but-dirty parent without losing its original edits", async () => {
    const dirtyContent = `${task.rawContent}\n<!-- operator context retained -->\n`;
    await fs.writeFile(parentPath, dirtyContent, "utf-8");
    task = parseTaskFile(dirtyContent, parentPath);
    topology = fullTopology(task);
    mockRunReadinessGate.mockResolvedValue({ outcome: "pass", task });
    mockDecomposeTask.mockResolvedValue(topology);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.decomposed).toBe(true);
    const committedParent = await fs.readFile(parentPath, "utf-8");
    expect(committedParent).toContain("**Status:** DECOMPOSED");
    expect(committedParent).toContain("operator context retained");
  });

  test("commits an untracked parent together with its ready children", async () => {
    git(root, ["rm", "-q", "--cached", "--", "docs/tasks/TASK-006-browser-smoke-harness.md"]);
    git(root, ["commit", "-q", "-m", "untrack parent fixture"]);
    initialHead = git(root, ["rev-parse", "HEAD"]);

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.decomposed).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(initialHead);
    expect(git(root, ["ls-files", "--", "docs/tasks/TASK-006-browser-smoke-harness.md"])).toBe(
      "docs/tasks/TASK-006-browser-smoke-harness.md",
    );
  });

  test("refuses a hard-linked parent before any transaction write", async () => {
    await fs.link(parentPath, path.join(root, "parent-hardlink.md"));

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({ errorType: "write_failed" });
    expect(await fs.readFile(parentPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("refuses a symlink parent without mutating its external target", async () => {
    const targetPath = path.join(root, "external-parent.md");
    await fs.rename(parentPath, targetPath);
    try {
      await fs.symlink(targetPath, parentPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const result = await runPreflight(task, adapter, { force: true });

    expect(result.decomposition?.refused).toMatchObject({ errorType: "write_failed" });
    expect(await fs.readFile(targetPath, "utf-8")).toBe(task.rawContent);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  test("refuses a task-directory link that resolves outside the project", async () => {
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-external-task-dir-"));
    const taskDir = path.dirname(parentPath);
    try {
      await fs.rename(parentPath, path.join(externalDir, path.basename(parentPath)));
      await fs.rm(taskDir, { recursive: true, force: true });
      await fs.symlink(externalDir, taskDir, process.platform === "win32" ? "junction" : "dir");

      const result = await runPreflight(task, adapter, { force: true });

      expect(result.decomposition?.refused).toMatchObject({ errorType: "write_failed" });
      expect(await fs.readFile(path.join(externalDir, path.basename(parentPath)), "utf-8")).toBe(
        task.rawContent,
      );
      expect(git(root, ["rev-parse", "HEAD"])).toBe(initialHead);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
