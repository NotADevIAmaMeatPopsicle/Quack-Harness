// ─── Subtask Writer Tests ──────────────────────────────────────────
// Tests for writeSubtaskSpecs (ChildDraft[] -> disk) and
// commitSubtaskSpecs (TASK-900 fix).

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { writeSubtaskSpecs, commitSubtaskSpecs } from "../../src/preflight/subtask-writer.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { ChildDraft } from "../../src/preflight/decompose-types.js";

// ─── Helpers ────────────────────────────────────────────────────────

function makeAdapter(tempDir: string): ProjectAdapter {
  return {
    projectRoot: tempDir,
    config: {
      project: {
        name: "test",
        root: tempDir,
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      modelRouting: {
        gateModel: "claude-sonnet-4-20250514",
        enrichModel: "claude-sonnet-4-20250514",
        plannerModel: "claude-sonnet-4-20250514",
        workerModel: "claude-sonnet-4-20250514",
        workerComplexModel: "claude-opus-4-20250514",
        judgeModel: "claude-sonnet-4-20250514",
        retryEscalation: false,
      },
      agent: {
        model: "claude-sonnet-4-20250514",
        judgeModel: "claude-sonnet-4-20250514",
        enrichModel: "claude-sonnet-4-20250514",
        maxTurns: 100,
        maxBudgetPerTask: 10,
        maxRetries: 1,
      },
      verification: { commands: [], conventionChecks: [] },
      sandbox: {
        writablePaths: ["src/**"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        requireCleanTree: true,
        protectedBranches: ["main"],
        allowedRemotes: ["origin"],
      },
      logging: { logDir: ".quack/logs", writeEvents: true },
      automation: { autoPrep: { enabled: false, maxPerHour: 20, costLimitPerHour: 5.0 } },
      fleetBudget: { dailyLimit: 100, hourlyLimit: 10 },
      costVelocity: { enabled: false, alertThreshold: 2.0, killThreshold: 5.0, windowMinutes: 15 },
      stuckDetection: { enabled: false, fileHeartbeatIntervalMs: 30000, maxSilenceMs: 600000 },
      docker: {
        enabled: false,
        image: "node:18",
        memoryLimitMb: 2048,
        cpuLimit: 2.0,
        timeoutMinutes: 60,
      },
      queue: {
        enabled: false,
        maxConcurrent: 3,
        autoPause: { onFailure: true, afterCount: 1 },
        persistence: { enabled: true, file: ".quack/queue/state.json" },
      },
      preflight: {
        autoRun: false,
        complexityThresholds: {
          maxFilesBeforeDecompose: 6,
          maxCriteriaBeforeDecompose: 8,
          maxContextTokensBeforeDecompose: 35000,
          maxIndependentFeatures: 3,
        },
      },
    },
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    claudeMd: "",
  } as unknown as ProjectAdapter;
}

/** Build a minimal parseable child draft markdown for testing */
function makeChildDraftMarkdown(opts: {
  id: string;
  title: string;
  priority?: string;
  blockedBy?: string[];
  tags?: string[];
  successCriteria?: string[];
  filesToModify?: Array<{ path: string; action: string; notes?: string }>;
  includeAllParentCriterion?: boolean;
}): string {
  const priority = opts.priority ?? "P1-HIGH";
  const blockedBy = opts.blockedBy ?? [];
  const tags = opts.tags ?? ["subtask"];
  const criteria = opts.successCriteria ?? ["Criterion A implemented"];
  const files = opts.filesToModify ?? [{ path: "src/a.ts", action: "Create", notes: "" }];
  const allCriterion = opts.includeAllParentCriterion
    ? "\n- [ ] All parent task success criteria verified"
    : "";

  return `# ${opts.id}: ${opts.title}

## Metadata
- **Priority:** ${priority}
- **Effort:** 2-3 hours
- **Status:** READY
- **Blocked By:** [${blockedBy.join(", ")}]
- **Blocks:** []
- **Tags:** ${tags.join(", ")}

## Problem Statement
This child task implements the ${opts.title} component as part of the parent decomposition. It is responsible for the files listed below and the associated success criteria. The implementation must follow the patterns established in the blueprint and integrate cleanly with sibling subtasks.

## Current State
The files owned by this subtask are currently absent or incomplete. They must be implemented from scratch or updated according to the specifications described in the recommended approach below.

## Recommended Approach
First read the parent task blueprint to understand integration points. Then implement each file in dependency order, verifying each change compiles before moving to the next. Run the test suite after each file is complete.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
${files.map((f) => `| \`${f.path}\` | ${f.action} | ${f.notes ?? ""} |`).join("\n")}

## Success Criteria
${criteria.map((c) => `- [ ] ${c}`).join("\n")}${allCriterion}

## Testing Requirements
- [ ] Unit tests verify each function exported from the modified files
- [ ] Integration tests confirm correct behavior with adjacent modules
- [ ] \`npm run build\` succeeds with no type errors

## Anti-Patterns
- Do NOT copy-paste code from other subtasks without understanding dependencies
- Do NOT leave placeholder implementations that fail at runtime
- Do NOT skip error handling in public functions

## Context References
- Parent task: TASK-042
`;
}

function makeDraft(id: string, title: string): ChildDraft {
  return {
    subtaskId: id,
    title,
    markdown: makeChildDraftMarkdown({ id, title }),
    sectionsPresent: [],
    prepScore: 5,
    prepReady: true,
    deficiencies: [],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("subtask-writer", () => {
  let tempDir: string;
  let adapter: ProjectAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-subtask-writer-"));
    const taskDir = path.join(tempDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    adapter = makeAdapter(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("writeSubtaskSpecs", () => {
    it("should write subtask spec files to disk from ChildDraft[]", async () => {
      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-042-A",
          title: "Implement Module A",
          markdown: makeChildDraftMarkdown({
            id: "TASK-042-A",
            title: "Implement Module A",
            filesToModify: [{ path: "src/a.ts", action: "Create" }],
            successCriteria: ["Module A implemented"],
          }),
          sectionsPresent: ["Problem Statement", "Current State"],
          prepScore: 4.5,
          prepReady: true,
          deficiencies: [],
        },
        {
          subtaskId: "TASK-042-B",
          title: "Implement Module B",
          markdown: makeChildDraftMarkdown({
            id: "TASK-042-B",
            title: "Implement Module B",
            blockedBy: ["TASK-042-A"],
            filesToModify: [{ path: "src/b.ts", action: "Create" }],
            successCriteria: ["Module B implemented", "All parent task success criteria verified"],
            includeAllParentCriterion: false, // already in the array above
          }),
          sectionsPresent: ["Problem Statement", "Current State"],
          prepScore: 4.2,
          prepReady: true,
          deficiencies: [],
        },
      ];

      const writtenPaths = await writeSubtaskSpecs(drafts, adapter);

      expect(writtenPaths).toHaveLength(2);

      // The content written must be the draft markdown (not regenerated stubs)
      const content1 = await fs.readFile(writtenPaths[0], "utf-8");
      expect(content1).toBe(drafts[0].markdown);

      const content2 = await fs.readFile(writtenPaths[1], "utf-8");
      expect(content2).toBe(drafts[1].markdown);
    });

    it("should use slug of draft title in filename", async () => {
      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-123-A",
          title: "Implement The Registry Module",
          markdown: makeChildDraftMarkdown({
            id: "TASK-123-A",
            title: "Implement The Registry Module",
          }),
          sectionsPresent: [],
          prepScore: 4.0,
          prepReady: true,
          deficiencies: [],
        },
      ];

      const writtenPaths = await writeSubtaskSpecs(drafts, adapter);

      expect(path.basename(writtenPaths[0])).toMatch(/^TASK-123-A-implement-the-registry-module/);
    });

    it("should validate spec content before writing (reject unparseable draft)", async () => {
      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-999-A",
          title: "Bad Subtask",
          // This markdown will fail parseTaskFile because it has no metadata
          markdown: "# TASK-999-A: Bad Subtask\n\nJust some text, no metadata.\n",
          sectionsPresent: [],
          prepScore: 1.0,
          prepReady: false,
          deficiencies: ["Missing required section: ## Problem Statement"],
        },
      ];

      await expect(writeSubtaskSpecs(drafts, adapter)).rejects.toThrow(
        /failed parse at write time/,
      );
    });

    it("should prevent concurrent writes via lock file", async () => {
      const taskDir = path.join(tempDir, "docs", "tasks");
      const lockPath = path.join(taskDir, ".decompose.lock");

      // Place a lock file to simulate a concurrent operation
      await fs.writeFile(lockPath, "99999\n2026-01-01T00:00:00Z");

      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-042-A",
          title: "Subtask A",
          markdown: makeChildDraftMarkdown({ id: "TASK-042-A", title: "Subtask A" }),
          sectionsPresent: [],
          prepScore: 4.0,
          prepReady: true,
          deficiencies: [],
        },
      ];

      await expect(writeSubtaskSpecs(drafts, adapter)).rejects.toThrow(
        /Another decompose operation is in progress/,
      );

      // Clean up lock
      await fs.unlink(lockPath).catch(() => {});
    });

    it("should release lock file after writing (even if write fails)", async () => {
      const taskDir = path.join(tempDir, "docs", "tasks");
      const lockPath = path.join(taskDir, ".decompose.lock");

      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-042-A",
          title: "Bad Subtask",
          markdown: "# Bad spec — no metadata\n",
          sectionsPresent: [],
          prepScore: 0,
          prepReady: false,
          deficiencies: ["Parse failure"],
        },
      ];

      // Expect write to fail (bad markdown)
      await expect(writeSubtaskSpecs(drafts, adapter)).rejects.toThrow();

      // Lock should have been released
      await expect(fs.access(lockPath)).rejects.toThrow();
    });

    it("should write no files for empty drafts array", async () => {
      const writtenPaths = await writeSubtaskSpecs([], adapter);
      expect(writtenPaths).toHaveLength(0);
    });

    it("should NOT generate generic stubs — content is exactly the draft markdown", async () => {
      const richMarkdown = makeChildDraftMarkdown({
        id: "TASK-042-A",
        title: "Rich Subtask",
        successCriteria: ["Registry handles project lookup", "Tests pass"],
      });

      const drafts: ChildDraft[] = [
        {
          subtaskId: "TASK-042-A",
          title: "Rich Subtask",
          markdown: richMarkdown,
          sectionsPresent: ["Problem Statement", "Current State"],
          prepScore: 4.5,
          prepReady: true,
          deficiencies: [],
        },
      ];

      const writtenPaths = await writeSubtaskSpecs(drafts, adapter);
      const content = await fs.readFile(writtenPaths[0], "utf-8");

      // Must NOT contain generic stub phrases
      expect(content).not.toMatch(/This subtask is part of TASK-\w+ decomposition/i);
      expect(content).not.toMatch(/At least \d+×2 new tests/i);
      expect(content).not.toMatch(/Parent task TASK-\w+ was decomposed into multiple subtasks/i);
      expect(content).not.toMatch(/Follow the implementation patterns from the parent task/i);

      // Must contain the rich criteria from the draft
      expect(content).toContain("Registry handles project lookup");
    });
  });

  test("TASK-1345: refuses a differently named declared-id owner without partial writes", async () => {
    const taskDir = path.join(tempDir, "docs", "tasks");
    const ownerName = "TASK-999-existing-child.md";
    await fs.writeFile(
      path.join(taskDir, ownerName),
      makeChildDraftMarkdown({ id: "TASK-042-B", title: "Existing B" }),
      "utf-8",
    );

    await expect(
      writeSubtaskSpecs(
        [makeDraft("TASK-042-A", "Fresh A"), makeDraft("TASK-042-B", "New B")],
        adapter,
      ),
    ).rejects.toMatchObject({
      name: "TaskCreationIdentityConflictError",
      conflicts: [{ taskId: "TASK-042-B", claimants: [ownerName] }],
    });
    expect(await fs.readdir(taskDir)).toEqual([ownerName]);
  });

  test("TASK-1345: exact second destination refuses before the fresh first child is written", async () => {
    const taskDir = path.join(tempDir, "docs", "tasks");
    const existing = makeDraft("TASK-042-B", "Existing B");
    const existingPath = path.join(taskDir, "TASK-042-B-existing-b.md");
    await fs.writeFile(existingPath, existing.markdown, "utf-8");
    const before = await fs.readFile(existingPath, "utf-8");

    await expect(
      writeSubtaskSpecs([makeDraft("TASK-042-A", "Fresh A"), existing], adapter),
    ).rejects.toThrow("already exists");
    expect(await fs.readdir(taskDir)).toEqual([path.basename(existingPath)]);
    expect(await fs.readFile(existingPath, "utf-8")).toBe(before);
  });

  test("TASK-1345: intra-batch duplicate declarations refuse the whole batch", async () => {
    await expect(
      writeSubtaskSpecs(
        [makeDraft("TASK-042-A", "First A"), makeDraft("TASK-042-A", "Second A")],
        adapter,
      ),
    ).rejects.toThrow("duplicate ids: TASK-042-A");
    expect(await fs.readdir(path.join(tempDir, "docs", "tasks"))).toEqual([]);
  });

  describe("commitSubtaskSpecs (TASK-900)", () => {
    function initGitRepo(repoRoot: string): void {
      execSync("git init -q -b main", { cwd: repoRoot });
      execSync("git config user.email test@quack.local", { cwd: repoRoot });
      execSync("git config user.name Quack-Test", { cwd: repoRoot });
      execSync("git config commit.gpgsign false", { cwd: repoRoot });
      // Seed the repo with one committed file so HEAD resolves.
      const seedPath = path.join(repoRoot, "README.md");
      void seedPath;
      execSync("git add README.md", { cwd: repoRoot });
      execSync("git commit -q -m initial-seed", { cwd: repoRoot });
    }

    beforeEach(async () => {
      await fs.writeFile(path.join(tempDir, "README.md"), "# test\n", "utf-8");
      initGitRepo(tempDir);
    });

    test("commits the listed paths and returns committed=true with a SHA", async () => {
      const specPath = path.join(tempDir, "docs", "tasks", "TASK-100-A-foo.md");
      await fs.writeFile(specPath, "# TASK-100-A: Foo\n", "utf-8");

      const result = await commitSubtaskSpecs(adapter, [specPath], "TASK-100");

      expect(result.committed).toBe(true);
      expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(result.staged).toEqual(["docs/tasks/TASK-100-A-foo.md"]);

      // The new file should now be tracked by git
      const tracked = execSync("git ls-files docs/tasks/", { cwd: tempDir, encoding: "utf-8" });
      expect(tracked).toContain("TASK-100-A-foo.md");

      // And the commit message should be greppable
      const log = execSync("git log -1 --format=%s", { cwd: tempDir, encoding: "utf-8" });
      expect(log.trim()).toBe("docs(tasks): auto-commit subtasks for TASK-100");
    });

    test("returns committed=false when no paths are passed (empty plan)", async () => {
      const result = await commitSubtaskSpecs(adapter, [], "TASK-101");
      expect(result.committed).toBe(false);
      expect(result.staged).toEqual([]);
    });

    test("does NOT bundle unrelated dirty files in the auto-commit", async () => {
      // Operator's working tree has an unrelated dirty file.
      const dirtyPath = path.join(tempDir, "src.ts");
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(dirtyPath, "// dirty\n", "utf-8");

      // Commit a freshly-written subtask spec.
      const specPath = path.join(tempDir, "docs", "tasks", "TASK-102-A-bar.md");
      await fs.writeFile(specPath, "# TASK-102-A: Bar\n", "utf-8");

      const result = await commitSubtaskSpecs(adapter, [specPath], "TASK-102");
      expect(result.committed).toBe(true);

      // The unrelated dirty file should still be uncommitted.
      const status = execSync("git status --porcelain src.ts", { cwd: tempDir, encoding: "utf-8" });
      expect(status).toMatch(/src\.ts/);
    });

    test("preserves unrelated pre-staged changes outside the path-limited commit", async () => {
      const readmePath = path.join(tempDir, "README.md");
      await fs.writeFile(readmePath, "# operator staged change\n", "utf-8");
      execSync("git add README.md", { cwd: tempDir });

      const specPath = path.join(tempDir, "docs", "tasks", "TASK-104-A-qux.md");
      await fs.writeFile(specPath, "# TASK-104-A: Qux\n", "utf-8");

      const result = await commitSubtaskSpecs(adapter, [specPath], "TASK-104");
      expect(result.committed).toBe(true);

      const committedPaths = execSync("git show --pretty=format: --name-only HEAD", {
        cwd: tempDir,
        encoding: "utf-8",
      })
        .trim()
        .split(/\r?\n/);
      expect(committedPaths).toEqual(["docs/tasks/TASK-104-A-qux.md"]);
      expect(
        execSync("git diff --cached --name-only", {
          cwd: tempDir,
          encoding: "utf-8",
        }).trim(),
      ).toBe("README.md");
      expect(
        execSync("git show HEAD:README.md", {
          cwd: tempDir,
          encoding: "utf-8",
        }),
      ).toBe("# test\n");
    });

    test("returns committed=false when spec is already committed (idempotent)", async () => {
      const specPath = path.join(tempDir, "docs", "tasks", "TASK-103-A-baz.md");
      await fs.writeFile(specPath, "# TASK-103-A: Baz\n", "utf-8");

      // First call commits.
      const first = await commitSubtaskSpecs(adapter, [specPath], "TASK-103");
      expect(first.committed).toBe(true);

      // Second call with same content + already-tracked path: nothing new to commit.
      const second = await commitSubtaskSpecs(adapter, [specPath], "TASK-103");
      expect(second.committed).toBe(false);
    });
  });
});
