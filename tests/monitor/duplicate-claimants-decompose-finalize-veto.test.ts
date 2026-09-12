// TASK-1338-B pre-change record: all four finalize arms executed and FAILED
// at the expected 409 assertion after child creation. Plan, materialize, and
// missing-review are CONTROL arms whose earlier returns must remain ungated.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
    extra: "- [ ] Verify a single-owner finalize writes both child tasks",
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
  (materializeChildDrafts as jest.MockedFunction<typeof materializeChildDrafts>).mockResolvedValue(
    drafts,
  );
}

function prepareFixture(fixture: ReturnType<typeof createSingleClaimantFixture>): void {
  for (const filePath of fixture.claimantPaths) {
    fs.writeFileSync(filePath, parentMarkdown, "utf-8");
    fixture.before.set(filePath, parentMarkdown);
  }
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

async function start(root: string, adapterPath: string) {
  const server = createMonitorServer({
    port: 0,
    host: "127.0.0.1",
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
      prepareFixture(fixture);
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
          drafts,
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
    prepareFixture(fixture);
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
  prepareFixture(fixture);
  const adapterPath = writeAdapter(fixture.root);
  configureMocks();
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
      mode: "finalize",
      drafts,
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
  prepareFixture(fixture);
  const adapterPath = writeAdapter(fixture.root);
  writePassingPrep(fixture.root);
  configureMocks();
  initGit(fixture.root);
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await start(fixture.root, adapterPath);
    stop = started.stop;
    const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts,
      plan: topology,
    });
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(fixture.taskDir, "TASK-100-A-generated-child.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(fixture.taskDir, "TASK-100-B-final-verification-child.md")),
    ).toBe(true);
  } finally {
    await stop?.();
    removeFixture(fixture.root);
  }
});
