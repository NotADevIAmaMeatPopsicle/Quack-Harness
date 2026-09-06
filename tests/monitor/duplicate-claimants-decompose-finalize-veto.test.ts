// TASK-1338-B pre-change record: all four finalize arms executed and FAILED
// at the expected 409 assertion after child creation. Plan, materialize, and
// missing-review are CONTROL arms whose earlier returns must remain ungated.

import * as fs from "node:fs";
import * as path from "node:path";

import { generateBlueprint } from "../../src/blueprint/blueprint-agent";
import { createMonitorServer } from "../../src/monitor/server";
import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import { materializeChildDrafts } from "../../src/preflight/subtask-materializer";
import { decomposeTask } from "../../src/preflight/task-decomposer";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  expectNoWriterArtifacts,
  expectPinnedHttpRefusal,
  postJson,
  removeFixture,
  taskSpec,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/blueprint/blueprint-agent", () => ({ generateBlueprint: jest.fn() }));
jest.mock("../../src/preflight/task-decomposer", () => ({ decomposeTask: jest.fn() }));
jest.mock("../../src/preflight/subtask-materializer", () => ({
  materializeChildDrafts: jest.fn(),
}));

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
      description: "fixture child",
      filesToModify: [{ path: "src/fixture.ts", action: "modify", notes: "fixture" }],
      successCriteria: ["child succeeds"],
      testingRequirements: ["child test"],
      dependsOn: [],
    },
  ],
  dependencyGraph: { nodes: ["TASK-100-A"], edges: [] },
  coverageReport: { hasCoverageGap: false, unmappedFiles: [], unmappedCriteria: [] },
} as unknown as DecompositionTopology;

function configureMocks(): void {
  (generateBlueprint as jest.MockedFunction<typeof generateBlueprint>).mockResolvedValue({
    summary: "fixture",
    fileAnalyses: [{ path: "src/fixture.ts", currentState: "old", changes: ["change"] }],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
  } as never);
  (decomposeTask as jest.MockedFunction<typeof decomposeTask>).mockResolvedValue(topology);
  (materializeChildDrafts as jest.MockedFunction<typeof materializeChildDrafts>).mockResolvedValue([
    draft,
  ]);
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

async function start(root: string, adapterPath: string) {
  const server = createMonitorServer({
    port: 30_000 + Math.floor(Math.random() * 10_000),
    projectRoot: root,
    taskDir: "docs/tasks",
    adapterPath,
    quackRoot: root,
    logDir: path.join(root, ".quack", "logs"),
  });
  return server.start();
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "HTTP decompose duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses immediately before writeSubtaskSpecs", async () => {
      const fixture = createDuplicateFixture("quack-http-decompose-veto-", kind, order);
      const adapterPath = writeAdapter(fixture.root);
      writePassingPrep(fixture.root);
      configureMocks();
      let stop: (() => Promise<void>) | undefined;
      try {
        const started = await start(fixture.root, adapterPath);
        stop = started.stop;
        const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
          mode: "finalize",
          reviewAcknowledged: true,
          drafts: [draft],
          plan: topology,
        });
        expectPinnedHttpRefusal(response, fixture.claimants);
        expectClaimantsUnchanged(fixture);
        expectNoWriterArtifacts(fixture);
      } finally {
        await stop?.();
        removeFixture(fixture.root);
      }
    });
  },
);

it.each(["plan", "materialize"] as const)(
  "%s stays spec-neutral on a contested id",
  async (mode) => {
    const fixture = createDuplicateFixture(
      "quack-http-decompose-control-",
      "cross-population",
      "forward",
    );
    const adapterPath = writeAdapter(fixture.root);
    configureMocks();
    let stop: (() => Promise<void>) | undefined;
    try {
      const started = await start(fixture.root, adapterPath);
      stop = started.stop;
      const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
        mode,
        ...(mode === "materialize" ? { plan: topology } : {}),
      });
      expect(response.status).toBe(200);
      expect(response.body.mode).toBe(mode);
      expectClaimantsUnchanged(fixture);
      expectNoWriterArtifacts(fixture);
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  },
);

it("missing review acknowledgment returns before the contested-id veto", async () => {
  const fixture = createDuplicateFixture(
    "quack-http-decompose-noop-",
    "cross-population",
    "forward",
  );
  const adapterPath = writeAdapter(fixture.root);
  configureMocks();
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
      mode: "finalize",
      drafts: [draft],
    });
    expect(response.status).toBe(400);
    expect(response.body.refusalCode).toBe("DECOMPOSE_REVIEW_REQUIRED");
    expectClaimantsUnchanged(fixture);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});

it("finalizes normally with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-http-decompose-single-");
  const adapterPath = writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [draft],
      plan: topology,
    });
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(fixture.taskDir, "TASK-100-A-generated-child.md"))).toBe(true);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
