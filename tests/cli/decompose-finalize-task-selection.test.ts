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

import { decomposeCommand } from "../../src/cli/decompose";
import type { ChildDraft } from "../../src/preflight/decompose-types";

function spec(id: string, status = "READY"): string {
  return [
    `# ${id}: selection fixture`,
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
    `${id} must resolve to its own file before decomposition.`,
    "",
    "## Current State",
    "The fixture has not been decomposed.",
    "",
    "## Recommended Approach",
    "Create one independent child task.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/fixture.ts` | Create | Fixture module |",
    "",
    "## Success Criteria",
    "- [ ] The correct parent becomes a tracker",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the real directory",
    "",
  ].join("\n");
}

function makeDraft(): ChildDraft {
  return {
    subtaskId: "TASK-100-B",
    title: "generated child",
    markdown: spec("TASK-100-B"),
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
    let exitCode: number | undefined;
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let logSpy: jest.SpiedFunction<typeof console.log>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cli-decompose-selection-"));
      taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      parentPath = path.join(taskDir, "TASK-100-parent.md");
      childPath = path.join(taskDir, "TASK-100-A-child.md");

      const childContent =
        childShape === "valid" ? spec("TASK-100-A") : "unparseable child sentinel\n";
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

      // Finalize compares the parent spec mtime with this record, so the prep
      // fixture must be written only after both task files exist.
      writePassingPrep(root);
      draftsFile = path.join(root, ".quack", "drafts.json");
      fs.writeFileSync(draftsFile, JSON.stringify([makeDraft()]), "utf-8");

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
        expect(naive).toBe("TASK-100-A-child.md");
      }
    });

    it("finalizes the parent tracker, writes the draft, and preserves the child", async () => {
      await decomposeCommand("TASK-100", {
        mode: "finalize",
        draftsFile,
        reviewAcknowledged: true,
        project: root,
      });

      expect(exitCode).toBe(0);
      const parentAfter = fs.readFileSync(parentPath, "utf-8");
      expect(parentAfter).toContain("**Status:** DECOMPOSED");
      expect(parentAfter).toContain("## Decomposition Summary");
      expect(fs.existsSync(path.join(taskDir, "TASK-100-B-generated-child.md"))).toBe(true);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
    });
  },
);
