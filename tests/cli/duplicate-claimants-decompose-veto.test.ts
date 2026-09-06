// TASK-1338-B pre-change record: all four finalize executions reached
// writeSubtaskSpecs and FAILED at the intended exit-code assertion after
// writing a child. Plan and materialize are CONTROL arms for spec-neutral
// modes and are covered behaviorally by the finalize matrix.

import * as fs from "node:fs";
import * as path from "node:path";

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

const draft: ChildDraft = {
  subtaskId: "TASK-100-A",
  title: "generated child",
  markdown: taskSpec("TASK-100-A"),
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

const topology = {
  parentTaskId: "TASK-100",
  reason: "fixture",
  subtasks: [
    {
      id: "TASK-100-A",
      title: "generated child",
      description: "fixture",
      filesToModify: [{ path: "src/fixture.ts", action: "modify", notes: "fixture" }],
      successCriteria: ["child succeeds"],
      testingRequirements: ["child test"],
      dependsOn: [],
    },
  ],
  dependencyGraph: { nodes: ["TASK-100-A"], edges: [] },
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
  (materializeChildDrafts as jest.MockedFunction<typeof materializeChildDrafts>).mockResolvedValue([
    draft,
  ]);
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
      writeAdapter(fixture.root);
      writePassingPrep(fixture.root);
      configureMocks();
      const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
      fs.writeFileSync(draftsFile, JSON.stringify([draft]), "utf-8");
      try {
        const result = await runCommand(fixture.root, {
          mode: "finalize",
          reviewAcknowledged: true,
          draftsFile,
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
  writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  const draftsFile = path.join(fixture.root, ".quack", "drafts.json");
  fs.writeFileSync(draftsFile, JSON.stringify([draft]), "utf-8");
  try {
    const result = await runCommand(fixture.root, {
      mode: "finalize",
      reviewAcknowledged: true,
      draftsFile,
    });
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(fixture.taskDir, "TASK-100-A-generated-child.md"))).toBe(true);
  } finally {
    removeFixture(fixture.root);
  }
});
