// ─── TASK-1334 (S1-R2): lifecycle picks the PARENT, against a real disk ──
//
// This suite exists because `lifecycle-manager.test.ts` stubs the resolver.
// That stub is legitimate there (those tests are about orchestration) but it
// would be a false green on its own, so file SELECTION is proved here instead,
// with no filesystem mocking at all.
//
// The site under test is the destructive one. `updateTaskStatus` rewrites the
// spec's `Status:` line, and `atomicCommit` stages every task markdown and
// commits it under the PARENT's task id, so selecting a subtask here does not
// just read the wrong file: it publishes a status change onto another task's
// spec.
//
// Observed FAILING against the pre-change implementation, in both directory
// orders: the parent never reached COMPLETE because the child was rewritten
// instead.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { updateTaskStatus } from "../../src/dispatcher/lifecycle-manager.js";

function spec(id: string, status = "READY"): string {
  return [
    `# ${id}: fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    "",
    `${id} body`,
    "",
    "## Success Criteria",
    "- [ ] It resolves",
    "",
    "## Testing Requirements",
    "- [ ] None (fixture)",
    "",
  ].join("\n");
}

/**
 * Both CREATION orders. Creating the child first is what reproduces the defect
 * on NTFS, but that is a property of this filesystem rather than a guarantee,
 * so neither result is allowed to depend on it.
 */
describe.each([["child-first"], ["parent-first"]])(
  "TASK-1334: updateTaskStatus writes the parent, not its subtask (%s)",
  (order) => {
    let root: string;
    let taskDir: string;
    let childBefore: string;
    let parentBefore: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-lifecycle-sel-"));
      taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      // `.quack` so the lifecycle error log resolves a project root rather
      // than walking to the filesystem root on failure.
      fs.mkdirSync(path.join(root, ".quack"), { recursive: true });

      const files: Array<[string, string]> = [
        ["TASK-100-A-child.md", spec("TASK-100-A")],
        ["TASK-100-parent.md", spec("TASK-100")],
      ];
      for (const [name, content] of order === "child-first" ? files : [...files].reverse()) {
        fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
      }
      // Round 2 (R2-4): byte-level baselines, so "untouched" means untouched
      // rather than merely "still contains READY".
      childBefore = fs.readFileSync(path.join(taskDir, "TASK-100-A-child.md"), "utf-8");
      parentBefore = fs.readFileSync(path.join(taskDir, "TASK-100-parent.md"), "utf-8");
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
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

    it("rewrites only the parent's Status", async () => {
      const ok = await updateTaskStatus("TASK-100", taskDir, "COMPLETE");
      expect(ok).toBe(true);

      const parent = fs.readFileSync(path.join(taskDir, "TASK-100-parent.md"), "utf-8");
      const child = fs.readFileSync(path.join(taskDir, "TASK-100-A-child.md"), "utf-8");

      expect(parent).toContain("**Status:** COMPLETE");
      // The one that failed pre-change: the child was the file that got
      // rewritten, under the parent's id.
      expect(child).toContain("**Status:** READY");
      expect(child).not.toContain("**Status:** COMPLETE");
      // Round 2 (R2-4): byte-identical, not merely still-READY.
      expect(child).toBe(childBefore);
    });

    it("still finds the subtask for its OWN id", async () => {
      const ok = await updateTaskStatus("TASK-100-A", taskDir, "COMPLETE");
      expect(ok).toBe(true);

      const child = fs.readFileSync(path.join(taskDir, "TASK-100-A-child.md"), "utf-8");
      const parent = fs.readFileSync(path.join(taskDir, "TASK-100-parent.md"), "utf-8");
      expect(child).toContain("**Status:** COMPLETE");
      // Narrowing the parent lookup must not break subtask resolution.
      expect(parent).toContain("**Status:** READY");
      // Round 2 (R2-4): the parent is byte-identical when its child updates.
      expect(parent).toBe(parentBefore);
    });
  },
);
