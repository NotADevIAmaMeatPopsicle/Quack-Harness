// TASK-1334 S1-R4: updateTaskFileStatus resolves the PARENT in a real repo.
//
// PRE-CHANGE OBSERVATION (2447d7ba, ablation worktree, 2026-08-16): FAILED in
// BOTH creation orders; the CHILD was rewritten to COMPLETE, committed under
// the parent's id and pushed, while the parent at origin still read READY.
// That is the armed-pair scenario (child in READY) reproduced against a real
// bare origin.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { updateTaskFileStatus } from "../../src/dispatcher/branch-manager";

jest.setTimeout(120000);

const originalGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
beforeAll(() => {
  process.env.GIT_TERMINAL_PROMPT = "0";
});
afterAll(() => {
  if (originalGitTerminalPrompt === undefined) {
    delete process.env.GIT_TERMINAL_PROMPT;
  } else {
    process.env.GIT_TERMINAL_PROMPT = originalGitTerminalPrompt;
  }
});

function spec(id: string, status = "READY"): string {
  return [
    `# ${id}: selection fixture`,
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
    `${id} must resolve to its own file.`,
    "",
    "## Success Criteria",
    "- [ ] The correct spec changes",
    "",
    "## Testing Requirements",
    "- [ ] Exercise a real bare origin",
    "",
  ].join("\n");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Both CREATION orders. Creating the child first is what reproduces the defect
 * on NTFS, but that is a property of this filesystem rather than a guarantee,
 * so neither result is allowed to depend on it.
 */
describe.each([["child-first"], ["parent-first"]])(
  "TASK-1334: updateTaskFileStatus publishes the parent status (%s)",
  (order) => {
    let root: string;
    let originRoot: string;
    let projectRoot: string;
    let verificationRoot: string;
    let taskDir: string;
    let childBefore: string;
    let adapter: ProjectAdapter;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-branch-status-selection-"));
      originRoot = path.join(root, "origin.git");
      projectRoot = path.join(root, "project");
      verificationRoot = path.join(root, "verification");

      git(root, ["init", "--bare", originRoot]);
      git(root, ["clone", originRoot, projectRoot]);
      git(projectRoot, ["config", "user.email", "quack-test@example.com"]);
      git(projectRoot, ["config", "user.name", "Quack Test"]);
      git(projectRoot, ["config", "commit.gpgsign", "false"]);
      git(projectRoot, ["checkout", "-b", "dev"]);

      taskDir = path.join(projectRoot, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
      const childPath = path.join(taskDir, "TASK-100-A-child.md");
      const parentPath = path.join(taskDir, "TASK-100-parent.md");
      const files: Array<[string, string]> = [
        [childPath, spec("TASK-100-A")],
        [parentPath, spec("TASK-100")],
      ];
      for (const [filePath, fileContent] of order === "child-first"
        ? files
        : [...files].reverse()) {
        fs.writeFileSync(filePath, fileContent, "utf-8");
      }
      childBefore = fs.readFileSync(childPath, "utf-8");

      git(projectRoot, ["add", "docs/tasks"]);
      git(projectRoot, ["commit", "-m", "test fixture"]);
      git(projectRoot, ["push", "-u", "origin", "dev"]);

      // This clone is deliberately separate from adapter.projectRoot. The
      // assertions below read origin/dev through Git after an explicit fetch.
      git(root, ["clone", "--branch", "dev", originRoot, verificationRoot]);

      adapter = {
        projectRoot,
        config: {
          project: { taskDir: "docs/tasks" },
        },
      } as ProjectAdapter;
    });

    afterEach(() => {
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

    it("commits and pushes COMPLETE only for the parent", async () => {
      const result = await updateTaskFileStatus("TASK-100", adapter, "dev");
      expect(result).toEqual({ success: true });

      git(verificationRoot, ["fetch", "origin", "dev"]);
      const parentAtOrigin = git(verificationRoot, [
        "show",
        "origin/dev:docs/tasks/TASK-100-parent.md",
      ]);
      const childAtOrigin = git(verificationRoot, [
        "show",
        "origin/dev:docs/tasks/TASK-100-A-child.md",
      ]);
      const commitSubject = git(verificationRoot, [
        "log",
        "-1",
        "--format=%s",
        "origin/dev",
      ]).trim();

      expect(parentAtOrigin).toContain("**Status:** COMPLETE");
      expect(childAtOrigin).toBe(childBefore);
      expect(childAtOrigin).toContain("**Status:** READY");
      expect(commitSubject).toBe("[TASK-100] mark complete (auto-merge)");
      expect(fs.existsSync(path.join(projectRoot, ".quack", "tmp-status-update"))).toBe(false);
    });
  },
);
