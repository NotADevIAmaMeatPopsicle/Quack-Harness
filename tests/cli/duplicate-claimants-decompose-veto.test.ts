// TASK-1338-B pre-change record: all four finalize executions reached
// writeSubtaskSpecs and FAILED at the intended exit-code assertion after
// writing a child. Plan and materialize are CONTROL arms for spec-neutral
// modes and are covered behaviorally by the finalize matrix.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { generateBlueprint } from "../../src/blueprint/blueprint-agent";
import { decomposeCommand } from "../../src/cli/decompose";
import { assembleContext } from "../../src/dispatcher/context-assembler";
import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import { materializeChildDrafts } from "../../src/preflight/subtask-materializer";
import { decomposeTask } from "../../src/preflight/task-decomposer";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  expectNoWriterArtifacts,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/blueprint/blueprint-agent", () => ({ generateBlueprint: jest.fn() }));
jest.mock("../../src/preflight/task-decomposer", () => ({ decomposeTask: jest.fn() }));
jest.mock("../../src/preflight/subtask-materializer", () => ({
  materializeChildDrafts: jest.fn(),
}));
jest.mock("../../src/dispatcher/context-assembler", () => ({ assembleContext: jest.fn() }));

const parentMarkdown = taskSpec("TASK-100").replace(
  "| `src/fixture.ts` | Modify | Exercise the fixture |",
  [
    "| `src/fixture.ts` | Modify | Exercise the fixture |",
    "| `src/final.ts` | Create | Verify the completed decomposition |",
  ].join("\n"),
);

const draftA: ChildDraft = {
  subtaskId: "TASK-100-A",
  title: "generated child",
  markdown: taskSpec("TASK-100-A", {
    title: "generated child",
    extra: "- [ ] Verify the finalized task remains independently reviewable",
  }).replace("- [ ] Ambiguous mutation is refused\n", ""),
  sectionsPresent: [
    "Problem Statement",
    "Current State",
    "Recommended Approach",
    "Files to Modify",
    "Success Criteria",
    "Testing Requirements",
  ],
  prepScore: 4.8,
  prepReady: true,
  deficiencies: [],
};

const draftB: ChildDraft = {
  subtaskId: "TASK-100-B",
  title: "final verification child",
  markdown: taskSpec("TASK-100-B", {
    title: "final verification child",
    extra: "- [ ] Verify the parent criteria remain covered after finalization",
  })
    .replace("- **Blocked By:** []", "- **Blocked By:** [TASK-100-A]")
    .replace(
      "| `src/fixture.ts` | Modify | Exercise the fixture |",
      "| `src/final.ts` | Create | Verify the completed decomposition |",
    )
    .replace("- [ ] The intended task spec is the only mutation target\n", ""),
  sectionsPresent: [
    "Problem Statement",
    "Current State",
    "Recommended Approach",
    "Files to Modify",
    "Success Criteria",
    "Testing Requirements",
  ],
  prepScore: 4.8,
  prepReady: true,
  deficiencies: [],
};

const drafts = [draftA, draftB];

const topology = {
  parentTaskId: "TASK-100",
  parentContentHash: createHash("sha256").update(parentMarkdown).digest("hex"),
  reason: "fixture",
  subtasks: [
    {
      id: "TASK-100-A",
      title: "generated child",
      filesToModify: [{ path: "src/fixture.ts", action: "Modify", notes: "fixture" }],
      successCriteria: ["The intended task spec is the only mutation target"],
      dependsOn: [],
      isFinal: false,
    },
    {
      id: "TASK-100-B",
      title: "final verification child",
      filesToModify: [
        { path: "src/final.ts", action: "Create", notes: "Verify the completed decomposition" },
      ],
      successCriteria: ["Ambiguous mutation is refused"],
      dependsOn: ["TASK-100-A"],
      isFinal: true,
    },
  ],
  dependencyGraph: {
    nodes: ["TASK-100-A", "TASK-100-B"],
    edges: [{ from: "TASK-100-A", to: "TASK-100-B" }],
  },
  coverageReport: {
    hasCoverageGap: false,
    unmappedFiles: [],
    unmappedCriteria: [],
    duplicatedFiles: [],
  },
} as unknown as DecompositionTopology;

function configureMocks(): void {
  (generateBlueprint as jest.MockedFunction<typeof generateBlueprint>).mockResolvedValue({
    summary: "fixture",
    fileAnalyses: [{ path: "src/fixture.ts" }],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
  } as never);
  (decomposeTask as jest.MockedFunction<typeof decomposeTask>).mockResolvedValue(topology);
  (materializeChildDrafts as jest.MockedFunction<typeof materializeChildDrafts>).mockResolvedValue(
    drafts,
  );
  (assembleContext as jest.MockedFunction<typeof assembleContext>).mockResolvedValue({
    task: {} as never,
    contextSizeEstimate: {
      taskSpec: 10,
      blueprint: 10,
      repoMap: 0,
      relevantFiles: 0,
      relatedPatterns: 0,
      existingTests: 0,
      conventions: 0,
      claudeMd: 0,
      total: 20,
      withinBudget: true,
    },
  } as never);
}

function prepareFixture(fixture: ReturnType<typeof createSingleClaimantFixture>): void {
  for (const filePath of fixture.claimantPaths) {
    fs.writeFileSync(filePath, parentMarkdown, "utf-8");
    fixture.before.set(filePath, parentMarkdown);
  }
}

function writePlan(root: string, plan: DecompositionTopology = topology): string {
  const planFile = path.join(root, ".quack", "topology.json");
  fs.writeFileSync(planFile, JSON.stringify(plan), "utf-8");
  return planFile;
}

function initGit(root: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "quack-test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  execFileSync("git", ["add", ".quack/adapter.json", "docs/tasks"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
}

function writePassingPrep(root: string): void {
  const prepDir = path.join(root, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, "TASK-100.json"),
    JSON.stringify({
      taskId: "TASK-100",
      preparedAt: new Date(Date.now() + 2_000).toISOString(),
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.8,
      depthReady: true,
      deficiencies: [],
      outcome: "pass",
      stale: false,
    }),
    "utf-8",
  );
}

async function runCommand(
  root: string,
  options: Parameters<typeof decomposeCommand>[1],
): Promise<{ exitCode: number | undefined; stderr: string }> {
  let exitCode: number | undefined;
  const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
    exitCode = typeof code === "number" ? code : 0;
    return undefined as never;
  });
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await decomposeCommand("TASK-100", { project: root, ...options });
    return { exitCode, stderr: errorSpy.mock.calls.flat().join(" ") };
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "CLI decompose duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses immediately before writeSubtaskSpecs", async () => {
      const fixture = createDuplicateFixture("quack-cli-decompose-veto-", kind, order);
      prepareFixture(fixture);
      writeAdapter(fixture.root);
      writePassingPrep(fixture.root);
      configureMocks();
      const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
      fs.writeFileSync(draftsFile, JSON.stringify(drafts), "utf-8");
      const planFile = writePlan(fixture.root);
      try {
        const result = await runCommand(fixture.root, {
          mode: "finalize",
          reviewAcknowledged: true,
          draftsFile,
          planFile,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("TASK-100");
        for (const claimant of fixture.claimants) expect(result.stderr).toContain(claimant);
        expectClaimantsUnchanged(fixture);
        expectNoWriterArtifacts(fixture);
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

it.each(["plan", "materialize"] as const)(
  "%s keeps contested claimant bytes unchanged",
  async (mode) => {
    const fixture = createDuplicateFixture(
      "quack-cli-decompose-control-",
      "cross-population",
      "forward",
    );
    prepareFixture(fixture);
    writeAdapter(fixture.root);
    configureMocks();
    try {
      const result = await runCommand(fixture.root, { mode });
      expect(result.exitCode).toBe(0);
      expectClaimantsUnchanged(fixture);
    } finally {
      removeFixture(fixture.root);
    }
  },
);

it("finalizes normally with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-decompose-single-");
  prepareFixture(fixture);
  writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  initGit(fixture.root);
  const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
  fs.writeFileSync(draftsFile, JSON.stringify(drafts), "utf-8");
  const planFile = writePlan(fixture.root);
  try {
    const result = await runCommand(fixture.root, {
      mode: "finalize",
      reviewAcknowledged: true,
      draftsFile,
      planFile,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(fixture.taskDir, "TASK-100-A-generated-child.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(fixture.taskDir, "TASK-100-B-final-verification-child.md")),
    ).toBe(true);
  } finally {
    removeFixture(fixture.root);
  }
});

it("rejects a forged clean coverage report when topology omits parent scope", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-decompose-forged-coverage-");
  prepareFixture(fixture);
  writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  initGit(fixture.root);
  const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
  fs.writeFileSync(draftsFile, JSON.stringify(drafts), "utf-8");
  const forgedPlan: DecompositionTopology = {
    ...topology,
    subtasks: topology.subtasks.map((subtask) => ({
      ...subtask,
      successCriteria: ["Ambiguous mutation is refused"],
    })),
    coverageReport: { ...topology.coverageReport, hasCoverageGap: false },
  };
  const planFile = writePlan(fixture.root, forgedPlan);
  try {
    const result = await runCommand(fixture.root, {
      mode: "finalize",
      reviewAcknowledged: true,
      draftsFile,
      planFile,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("coverage");
    expectClaimantsUnchanged(fixture);
    expectNoWriterArtifacts(fixture);
  } finally {
    removeFixture(fixture.root);
  }
});

it("rejects forged ready scores when a CLI draft is missing a required section", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-decompose-forged-quality-");
  prepareFixture(fixture);
  writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  initGit(fixture.root);
  const forgedDraft: ChildDraft = {
    ...draftA,
    prepScore: 5,
    prepReady: true,
    deficiencies: [],
    markdown: draftA.markdown.replace(/^## Anti-Patterns[\s\S]*?(?=^## Context References)/m, ""),
  };
  const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
  fs.writeFileSync(draftsFile, JSON.stringify([forgedDraft, draftB]), "utf-8");
  const planFile = writePlan(fixture.root);
  try {
    const result = await runCommand(fixture.root, {
      mode: "finalize",
      reviewAcknowledged: true,
      draftsFile,
      planFile,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("quality");
    expectClaimantsUnchanged(fixture);
    expectNoWriterArtifacts(fixture);
  } finally {
    removeFixture(fixture.root);
  }
});

it("rejects a forged topology above the configured child-count limit", async () => {
  const fixture = createSingleClaimantFixture("quack-cli-decompose-forged-count-");
  prepareFixture(fixture);
  writeAdapter(fixture.root);
  const adapterPath = path.join(fixture.root, ".quack", "adapter.json");
  const adapterConfig = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as Record<
    string,
    unknown
  >;
  adapterConfig.preflight = {
    autoDecompose: {
      enabled: true,
      maxSubtasks: 4,
      writeSpecs: true,
      parentPrepThreshold: 4,
    },
  };
  fs.writeFileSync(adapterPath, JSON.stringify(adapterConfig), "utf-8");
  writePassingPrep(fixture.root);
  configureMocks();
  initGit(fixture.root);
  const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
  fs.writeFileSync(draftsFile, JSON.stringify(drafts), "utf-8");
  const forgedPlan: DecompositionTopology = {
    ...topology,
    subtasks: Array.from({ length: 5 }, (_, index) => ({
      ...topology.subtasks[0],
      id: `TASK-100-${String.fromCharCode(65 + index)}`,
      dependsOn: index === 0 ? [] : [`TASK-100-${String.fromCharCode(64 + index)}`],
      isFinal: index === 4,
    })),
  };
  const planFile = writePlan(fixture.root, forgedPlan);
  try {
    const result = await runCommand(fixture.root, {
      mode: "finalize",
      reviewAcknowledged: true,
      draftsFile,
      planFile,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("child-count limit");
    expectClaimantsUnchanged(fixture);
    expectNoWriterArtifacts(fixture);
  } finally {
    removeFixture(fixture.root);
  }
});
