// TASK-1334 S1-R4: CLI decompose finalize resolves the PARENT once.
//
// PRE-CHANGE OBSERVATION (2447d7ba, ablation worktree, 2026-08-16): all four
// arms FAILED. With a valid child the CLI made the SELECTED child the tracker,
// so the parent never reached DECOMPOSED; with an unparseable child the
// command exited nonzero. Unlike the HTTP route, the old CLI had no separate
// canonical write, so even its valid-child arms fail pre-change.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { decomposeCommand } from "../../src/cli/decompose";
import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import { computeDecompositionParentHash } from "../../src/preflight/task-decomposer";
import * as decompositionFinalizer from "../../src/preflight/decomposition-finalizer";

function spec(id: string, status = "READY", title = "selection fixture"): string {
  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 4-6 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    `${id} must resolve to its own exact file before decomposition so no sibling or unrelated task can be modified accidentally.`,
    "",
    "## Current State",
    "The fixture has not been decomposed.",
    "",
    "## Recommended Approach",
    "Create two independently dispatchable child tasks.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/fixture-a.ts` | Create | First fixture module |",
    "| `src/fixture-b.ts` | Create | Final fixture module |",
    "",
    "## Success Criteria",
    "- [ ] The first child owns fixture A",
    "- [ ] The final child verifies fixture B",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the real directory",
    "- [ ] Verify the task identity remains stable",
    "",
    "## Anti-Patterns",
    "- Do not rewrite a different task claimant",
    "",
    "## Context References",
    "- Parent task: TASK-100",
    "",
  ].join("\n");
}

function makeDraft(suffix: "A" | "B"): ChildDraft {
  const subtaskId = `TASK-100-${suffix}`;
  const title = suffix === "A" ? "generated first child" : "generated final child";
  const filePath = suffix === "A" ? "src/fixture-a.ts" : "src/fixture-b.ts";
  const criterion =
    suffix === "A" ? "The first child owns fixture A" : "The final child verifies fixture B";
  const blockedBy = suffix === "A" ? "[]" : "[TASK-100-A]";
  const markdown = [
    `# ${subtaskId}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 2-3 hours",
    "- **Status:** READY",
    `- **Blocked By:** ${blockedBy}`,
    "- **Blocks:** []",
    "- **Tags:** fixture, decomposition",
    "",
    "## Problem Statement",
    `${subtaskId} owns one bounded fixture module and must remain independently dispatchable without changing its sibling's implementation scope.`,
    "",
    "## Current State",
    "The assigned fixture module does not exist yet and has no implementation coverage.",
    "",
    "## Recommended Approach",
    "Create only the assigned module, follow the parent contract, and verify its exact behavior.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    `| \`${filePath}\` | Create | Owned fixture module |`,
    "",
    "## Success Criteria",
    `- [ ] ${criterion}`,
    "",
    "## Testing Requirements",
    "- [ ] Exercise the owned fixture behavior",
    "- [ ] Verify the task identity remains stable",
    "",
    "## Anti-Patterns",
    "- Do not widen the child beyond its assigned fixture module",
    "",
    "## Context References",
    "- Parent task: TASK-100",
    "",
  ].join("\n");
  return {
    subtaskId,
    title,
    markdown,
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
}

function makeDrafts(): ChildDraft[] {
  return [makeDraft("A"), makeDraft("B")];
}

function writeAdapter(projectRoot: string): void {
  const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(
    adapterPath,
    JSON.stringify({
      version: "1.0",
      project: {
        name: "selection-fixture",
        root: projectRoot,
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {},
      verification: {
        commands: [{ name: "fixture", command: "echo ok", required: true, timeout: 60000 }],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoPush: false,
      },
      logging: { level: "info", dir: ".quack/logs", sessionDir: ".quack/logs" },
    }),
    "utf-8",
  );
}

function writePassingPrep(projectRoot: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, "TASK-100.json"),
    JSON.stringify({
      taskId: "TASK-100",
      preparedAt: new Date(Date.now() + 1000).toISOString(),
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

function writeStalePassingPrep(projectRoot: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, "TASK-100.json"),
    JSON.stringify({
      taskId: "TASK-100",
      preparedAt: new Date(Date.now() + 60_000).toISOString(),
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.8,
      depthReady: true,
      deficiencies: [],
      outcome: "pass",
      stale: false,
      contentHash: "not-the-current-parent-content-hash",
    }),
    "utf-8",
  );
}

function makeTopology(parentContent = spec("TASK-100")): DecompositionTopology {
  return {
    parentTaskId: "TASK-100",
    parentContentHash: computeDecompositionParentHash(parentContent),
    subtasks: [
      {
        id: "TASK-100-A",
        title: "generated first child",
        filesToModify: [
          { path: "src/fixture-a.ts", action: "Create", notes: "First fixture module" },
        ],
        successCriteria: ["The first child owns fixture A"],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-100-B",
        title: "generated final child",
        filesToModify: [
          { path: "src/fixture-b.ts", action: "Create", notes: "Final fixture module" },
        ],
        successCriteria: ["The final child verifies fixture B"],
        dependsOn: ["TASK-100-A"],
        isFinal: true,
      },
    ],
    coverageReport: {
      fileOwnership: [
        { filePath: "src/fixture-a.ts", ownedBy: "TASK-100-A", isShared: false },
        { filePath: "src/fixture-b.ts", ownedBy: "TASK-100-B", isShared: false },
      ],
      criterionOwnership: [
        { criterion: "The first child owns fixture A", ownedBy: ["TASK-100-A"] },
        { criterion: "The final child verifies fixture B", ownedBy: ["TASK-100-B"] },
      ],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      hasCoverageGap: false,
    },
  };
}

function createSingleParentFixture(): {
  root: string;
  taskDir: string;
  parentPath: string;
  initialHead: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cli-decompose-followup-"));
  const taskDir = path.join(root, "docs", "tasks");
  const parentPath = path.join(taskDir, "TASK-100-parent.md");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(parentPath, spec("TASK-100"), "utf-8");
  writeAdapter(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "quack-test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  execFileSync("git", ["add", ".quack/adapter.json", "docs/tasks"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  const initialHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  return { root, taskDir, parentPath, initialHead };
}

const cases = [
  ["unparseable", "child-first"],
  ["unparseable", "parent-first"],
  ["valid", "child-first"],
  ["valid", "parent-first"],
] as const;

/**
 * Both CREATION orders for both child shapes. Creating the child first is what
 * reproduces the defect on NTFS, but that is a property of this filesystem
 * rather than a guarantee, so neither result is allowed to depend on it.
 */
describe.each(cases)(
  "TASK-1334: CLI finalize writes the parent (%s child, %s)",
  (childShape, order) => {
    let root: string;
    let taskDir: string;
    let parentPath: string;
    let childPath: string;
    let childBefore: string;
    let draftsFile: string;
    let planFile: string;
    let initialHead: string;
    let unrelatedIndexBefore: string;
    let exitCode: number | undefined;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cli-decompose-selection-"));
      taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      parentPath = path.join(taskDir, "TASK-100-parent.md");
      childPath = path.join(taskDir, "TASK-100-0-child.md");

      const childContent =
        childShape === "valid" ? spec("TASK-100-Z") : "unparseable child sentinel\n";
      const files: Array<[string, string]> = [
        [childPath, childContent],
        [parentPath, spec("TASK-100")],
      ];
      for (const [filePath, fileContent] of order === "child-first"
        ? files
        : [...files].reverse()) {
        fs.writeFileSync(filePath, fileContent, "utf-8");
      }
      childBefore = fs.readFileSync(childPath, "utf-8");
      writeAdapter(root);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "quack-test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: root });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
      execFileSync("git", ["add", ".quack/adapter.json", "docs/tasks"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
      initialHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();
      fs.writeFileSync(path.join(root, "operator-notes.txt"), "keep this staged\n", "utf-8");
      execFileSync("git", ["add", "--", "operator-notes.txt"], { cwd: root });
      unrelatedIndexBefore = execFileSync("git", ["show", ":operator-notes.txt"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();

      // Finalize compares the parent spec mtime with this record, so the prep
      // fixture must be written only after both task files exist.
      writePassingPrep(root);
      draftsFile = path.join(root, ".quack", "drafts.json");
      fs.writeFileSync(draftsFile, JSON.stringify(makeDrafts()), "utf-8");
      planFile = path.join(root, ".quack", "topology.json");
      fs.writeFileSync(planFile, JSON.stringify(makeTopology()), "utf-8");

      exitCode = undefined;
      exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
        exitCode = typeof code === "number" ? code : 0;
        return undefined as never;
      });
      logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it("reproduces the wrong-pick condition, so the fixture is not vacuous", () => {
      // The CONTROL. If the naive selector ever stops preferring the child on
      // this order, the fixture no longer exercises the defect and the
      // assertion below would pass for the wrong reason.
      const naive = fs
        .readdirSync(taskDir)
        .find((f) => f.startsWith("TASK-100") && f.endsWith(".md"));
      expect(naive).toBeDefined();
      if (order === "child-first") {
        expect(naive).toBe("TASK-100-0-child.md");
      }
    });

    it("finalizes the parent tracker, writes the draft, and preserves the child", async () => {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        draftsFile,
        planFile,
        reviewAcknowledged: true,
        project: root,
      });

      expect(exitCode).toBe(0);
      const parentAfter = fs.readFileSync(parentPath, "utf-8");
      expect(parentAfter).toContain("**Status:** DECOMPOSED");
      expect(parentAfter).toContain("## Decomposition Summary");
      expect(fs.existsSync(path.join(taskDir, "TASK-100-A-generated-first-child.md"))).toBe(true);
      expect(fs.existsSync(path.join(taskDir, "TASK-100-B-generated-final-child.md"))).toBe(true);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
      expect(
        execFileSync("git", ["rev-list", "--count", `${initialHead}..HEAD`], {
          cwd: root,
          encoding: "utf-8",
        }).trim(),
      ).toBe("1");
      expect(
        execFileSync("git", ["show", "HEAD:docs/tasks/TASK-100-A-generated-first-child.md"], {
          cwd: root,
          encoding: "utf-8",
        }),
      ).toContain("# TASK-100-A:");
      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: root,
          encoding: "utf-8",
        }).trim(),
      ).toBe("operator-notes.txt");
      expect(
        execFileSync("git", ["show", ":operator-notes.txt"], {
          cwd: root,
          encoding: "utf-8",
        }).trim(),
      ).toBe(unrelatedIndexBefore);
    });
  },
);

describe("QPI-056 CLI finalize safety diagnostics", () => {
  it("does not enqueue a committed decomposition while recovery is pending", async () => {
    const { root, parentPath } = createSingleParentFixture();
    writePassingPrep(root);
    const draftsFile = path.join(root, ".quack", "drafts.json");
    const planFile = path.join(root, ".quack", "topology.json");
    const drafts = makeDrafts();
    const topology = makeTopology();
    fs.writeFileSync(draftsFile, JSON.stringify(drafts), "utf-8");
    fs.writeFileSync(planFile, JSON.stringify(topology), "utf-8");

    let exitCode: number | undefined;
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = jest.spyOn(global, "fetch");
    const finalizeSpy = jest
      .spyOn(decompositionFinalizer, "finalizeDecompositionTransaction")
      .mockResolvedValue({
        topology,
        coverageReport: topology.coverageReport,
        drafts,
        writtenPaths: drafts.map((draft) => path.join(root, `${draft.subtaskId}.md`)),
        parentStatusUpdated: true,
        parentContent: fs.readFileSync(parentPath, "utf-8"),
        commit: {
          committed: true,
          sha: "abcdef0",
          staged: [],
          recoveryPending: true,
          statusProjectionId: "a".repeat(64),
        },
      });

    try {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        draftsFile,
        planFile,
        reviewAcknowledged: true,
        enqueue: true,
        project: root,
      });

      expect(exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.flat().join("\n")).toContain(
        "Enqueue suppressed until the monitor reconciles the committed transaction.",
      );
    } finally {
      finalizeSpy.mockRestore();
      fetchSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("rejects a single-child plan without writing or committing", async () => {
    const { root, parentPath, initialHead } = createSingleParentFixture();
    writePassingPrep(root);
    const draftsFile = path.join(root, ".quack", "drafts.json");
    const planFile = path.join(root, ".quack", "topology.json");
    const singleDraft = makeDraft("A");
    const singlePlan = makeTopology();
    singlePlan.subtasks = [
      {
        ...singlePlan.subtasks[0],
        isFinal: true,
      },
    ];
    fs.writeFileSync(draftsFile, JSON.stringify([singleDraft]), "utf-8");
    fs.writeFileSync(planFile, JSON.stringify(singlePlan), "utf-8");
    let exitCode: number | undefined;
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        draftsFile,
        planFile,
        reviewAcknowledged: true,
        project: root,
      });

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/at least two/i);
      expect(fs.readFileSync(parentPath, "utf-8")).toContain("**Status:** READY");
      expect(
        fs.existsSync(path.join(root, "docs", "tasks", "TASK-100-A-generated-first-child.md")),
      ).toBe(false);
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim(),
      ).toBe(initialHead);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("rejects a hash-stale passing parent prep result before writing", async () => {
    const { root, parentPath, initialHead } = createSingleParentFixture();
    writeStalePassingPrep(root);
    let exitCode: number | undefined;
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        reviewAcknowledged: true,
        project: root,
      });

      expect(exitCode).toBe(1);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/prep result is stale/i);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/run 'quack prep TASK-100' again/i);
      expect(fs.readFileSync(parentPath, "utf-8")).toContain("**Status:** READY");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim(),
      ).toBe(initialHead);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it("prints every rollback diagnostic from a failed finalize transaction", async () => {
    const { root } = createSingleParentFixture();
    writePassingPrep(root);
    const draftsFile = path.join(root, ".quack", "drafts.json");
    const planFile = path.join(root, ".quack", "topology.json");
    fs.writeFileSync(draftsFile, JSON.stringify(makeDrafts()), "utf-8");
    fs.writeFileSync(planFile, JSON.stringify(makeTopology()), "utf-8");

    let exitCode: number | undefined;
    const exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = typeof code === "number" ? code : 0;
      return undefined as never;
    });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const finalizeSpy = jest
      .spyOn(decompositionFinalizer, "finalizeDecompositionTransaction")
      .mockRejectedValue(
        new decompositionFinalizer.DecompositionFinalizeError(
          "write_failed",
          "simulated finalize failure",
          {},
          ["restore parent failed", "remove child failed"],
        ),
      );

    try {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        draftsFile,
        planFile,
        reviewAcknowledged: true,
        project: root,
      });

      expect(exitCode).toBe(1);
      const errors = errorSpy.mock.calls.flat().join("\n");
      expect(errors).toContain("Decomposition failed: simulated finalize failure");
      expect(errors).toContain("Recovery remains incomplete:");
      expect(errors).toContain("restore parent failed");
      expect(errors).toContain("remove child failed");
    } finally {
      finalizeSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
