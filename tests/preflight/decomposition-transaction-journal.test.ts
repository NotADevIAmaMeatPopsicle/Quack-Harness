import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { withTaskCreationReservation } from "../../src/core/task-creation-reservation";
import type { AdapterConfig } from "../../src/core/types";
import { writeTaskFilesWithResult } from "../../src/planner/task-writer";
import type { ChildDraft } from "../../src/preflight/decompose-types";
import {
  decompositionTemporaryPath,
  writeDecompositionFileAtomicExclusive,
  writeDecompositionFileAtomicReplace,
} from "../../src/preflight/decomposition-file-io";
import {
  commitDecompositionTransaction,
  completeDecompositionTransactionJournal,
  createDecompositionTransactionJournal,
  decompositionJournalPathForTask,
  recoverPendingDecompositionTransactions,
  updateDecompositionTransactionJournal,
  withDecompositionAdmissionFence,
} from "../../src/preflight/decomposition-transaction-journal";
import { planSubtaskSpecWrites } from "../../src/preflight/subtask-writer";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

async function tryCreateDirectoryRedirect(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

function adapterFor(root: string): ProjectAdapter {
  const config = {
    version: "1.0",
    project: { name: "journal-test", root: ".", taskDir: "docs/tasks", conventionsDir: ".quack" },
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
      writablePaths: ["src/**"],
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
      sharedHash: "journal-test",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function taskMarkdown(id: string, title: string, status: "READY" | "DECOMPOSED"): string {
  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 2-3 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    status === "DECOMPOSED" ? `- **Blocks:** [${id}-A, ${id}-B]` : "- **Blocks:** []",
    "- **Tags:** journal, recovery",
    "",
    "## Problem Statement",
    "The transaction must survive interruption without exposing partial task state.",
    "",
    "## Current State",
    "No durable decomposition transaction has been completed for this task.",
    "",
    "## Recommended Approach",
    "Persist and reconcile the exact parent and child bytes as one transaction.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/example.ts` | Modify | Exercise recovery |",
    "",
    "## Success Criteria",
    "- [ ] Recovery preserves an all-or-nothing task topology",
    "",
    "## Testing Requirements",
    "- [ ] Simulate every durable phase boundary",
    "",
    "## Anti-Patterns",
    "- Do not overwrite bytes that no longer match the transaction",
    "",
    "## Context References",
    "- Transaction recovery contract",
    "",
    ...(status === "DECOMPOSED"
      ? [
          "## Decomposition Summary",
          "",
          "| Child | Scope | Blocked By | Readiness |",
          "|-------|-------|------------|-----------|",
          `| \`${id}-A\` | First child | None | prep 5 |`,
          `| \`${id}-B\` | Final child | ${id}-A | prep 5 |`,
          "",
        ]
      : []),
  ].join("\n");
}

function childMarkdown(id: string, title: string, dependsOn: string[] = []): string {
  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    `- **Blocked By:** [${dependsOn.join(", ")}]`,
    "- **Blocks:** []",
    "- **Tags:** journal, recovery, child",
    "",
    "## Problem Statement",
    "This child owns a bounded portion of the durable recovery test fixture.",
    "",
    "## Current State",
    "The owned fixture behavior has not been implemented or verified yet.",
    "",
    "## Recommended Approach",
    "Implement the owned fixture behavior and verify exact recovery semantics.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    `| \`src/${id.toLowerCase()}.ts\` | Create | Owned fixture |`,
    "",
    "## Success Criteria",
    `- [ ] ${title} is independently verified`,
    "",
    "## Testing Requirements",
    "- [ ] Exercise the successful and interrupted paths",
    "",
    "## Anti-Patterns",
    "- Do not widen this child beyond its assigned transaction path",
    "",
    "## Context References",
    "- Parent task: TASK-006",
    "",
  ].join("\n");
}

describe("durable decomposition transaction journal", () => {
  let root: string;
  let adapter: ProjectAdapter;
  let parentPath: string;
  let parentOriginal: string;
  let parentTarget: string;
  let drafts: ChildDraft[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-decompose-journal-"));
    await fs.mkdir(path.join(root, "docs", "tasks"), { recursive: true });
    parentPath = path.join(root, "docs", "tasks", "TASK-006-journal-parent.md");
    parentOriginal = taskMarkdown("TASK-006", "Journal parent", "READY");
    parentTarget = taskMarkdown("TASK-006", "Journal parent", "DECOMPOSED");
    await fs.writeFile(parentPath, parentOriginal, "utf-8");
    drafts = [
      {
        subtaskId: "TASK-006-A",
        title: "First child",
        markdown: childMarkdown("TASK-006-A", "First child"),
        sectionsPresent: [],
        prepScore: 5,
        prepReady: true,
        deficiencies: [],
      },
      {
        subtaskId: "TASK-006-B",
        title: "Final child",
        markdown: childMarkdown("TASK-006-B", "Final child", ["TASK-006-A"]),
        sectionsPresent: [],
        prepScore: 5,
        prepReady: true,
        deficiencies: [],
      },
    ];
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "quack-test@example.com"]);
    git(root, ["config", "user.name", "Quack Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "docs/tasks"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
    adapter = adapterFor(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  async function prepareJournal() {
    return createDecompositionTransactionJournal({
      adapter,
      parentTaskId: "TASK-006",
      parentFilePath: parentPath,
      parentOriginalContent: parentOriginal,
      parentTargetContent: parentTarget,
      plannedWrites: planSubtaskSpecWrites(drafts, adapter),
    });
  }

  async function writeChildren(count = drafts.length): Promise<string[]> {
    const planned = planSubtaskSpecWrites(drafts, adapter);
    for (const item of planned.slice(0, count)) {
      await fs.writeFile(item.filePath, item.draft.markdown, { encoding: "utf-8", flag: "wx" });
    }
    return planned.map((item) => item.filePath);
  }

  test.each([
    ["prepared", false, 0, false],
    ["parent_written", true, 0, false],
    ["children_written", true, 2, false],
    ["committing", true, 2, true],
  ] as const)(
    "rolls back an interrupted %s phase idempotently",
    async (phase, parentWasWritten, childCount, staged) => {
      const prepared = await prepareJournal();
      if (parentWasWritten) await fs.writeFile(parentPath, parentTarget, "utf-8");
      const childPaths = await writeChildren(childCount);
      await updateDecompositionTransactionJournal(prepared.journalPath, prepared.journal, phase);

      const unrelated = path.join(root, "operator-notes.txt");
      await fs.writeFile(unrelated, "keep staged\n", "utf-8");
      git(root, ["add", "--", "operator-notes.txt"]);
      if (staged) {
        git(root, [
          "add",
          "--",
          "docs/tasks/TASK-006-journal-parent.md",
          ...childPaths.map((item) => path.relative(root, item).replace(/\\/g, "/")),
        ]);
      }

      await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
        expect.objectContaining({ parentTaskId: "TASK-006", outcome: "rolled_back" }),
      ]);
      expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
      for (const childPath of childPaths) {
        await expect(fs.access(childPath)).rejects.toThrow();
      }
      expect(git(root, ["diff", "--cached", "--name-only"])).toBe("operator-notes.txt");
      await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([]);
    },
  );

  test("reconciles a crash after the exact commit and restores missing target worktree bytes", async () => {
    const prepared = await prepareJournal();
    await fs.writeFile(parentPath, parentTarget, "utf-8");
    const childPaths = await writeChildren();
    const transactionPaths = [
      "docs/tasks/TASK-006-journal-parent.md",
      ...childPaths.map((item) => path.relative(root, item).replace(/\\/g, "/")),
    ];
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "committing",
    );
    git(root, ["add", "--", ...transactionPaths]);
    git(root, ["commit", "-q", "--only", "-m", "decomposition", "--", ...transactionPaths]);

    await fs.writeFile(parentPath, parentOriginal, "utf-8");
    for (const childPath of childPaths) await fs.unlink(childPath);

    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ parentTaskId: "TASK-006", outcome: "committed_reconciled" }),
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentTarget);
    for (let index = 0; index < childPaths.length; index += 1) {
      expect(await fs.readFile(childPaths[index], "utf-8")).toBe(drafts[index].markdown);
    }
    expect(git(root, ["status", "--porcelain", "--", ...transactionPaths])).toBe("");
    await expect(fs.access(prepared.journalPath)).rejects.toThrow();
  });

  test("refuses an intervening HEAD advance at the atomic ref update boundary", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();

    await expect(
      commitDecompositionTransaction(adapter, prepared.journal, {
        beforeRefUpdate: () => {
          git(root, ["commit", "--allow-empty", "-q", "-m", "operator head advance"]);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();

    expect(git(root, ["log", "-1", "--format=%s"])).toBe("operator head advance");
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
  });

  test("refuses a same-OID symbolic branch swap under the index lock", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();
    git(root, ["branch", "alternate"]);

    try {
      await expect(
        commitDecompositionTransaction(adapter, prepared.journal, {
          afterIndexLock: () => {
            git(root, ["symbolic-ref", "HEAD", "refs/heads/alternate"]);
          },
        }),
      ).rejects.toThrow(/HEAD identity changed/);
      expect(git(root, ["rev-parse", "HEAD"])).toBe(prepared.journal.baseHead);
      expect(git(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/alternate");
      await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
    } finally {
      git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      await recoverPendingDecompositionTransactions(adapter);
    }
  });

  test("refuses and preserves an intervening transaction-path index entry", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();
    const operatorIndexContent = `${parentOriginal}\n<!-- operator staged index -->\n`;

    await expect(
      commitDecompositionTransaction(adapter, prepared.journal, {
        beforeRefUpdate: async () => {
          await fs.writeFile(parentPath, operatorIndexContent, "utf-8");
          git(root, ["add", "--", "docs/tasks/TASK-006-journal-parent.md"]);
          await fs.writeFile(parentPath, parentTarget, "utf-8");
        },
      }),
    ).rejects.toThrow("Index entry diverged");

    expect(git(root, ["show", ":docs/tasks/TASK-006-journal-parent.md"])).toBe(
      operatorIndexContent.trimEnd(),
    );
    expect(git(root, ["log", "-1", "--format=%s"])).toBe("fixture");
  });

  test("preserves unrelated staging introduced immediately before the index lock", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();
    const unrelated = path.join(root, "operator-notes.txt");

    const committed = await commitDecompositionTransaction(adapter, prepared.journal, {
      beforeRefUpdate: async () => {
        await fs.writeFile(unrelated, "operator staged concurrently\n", "utf-8");
        git(root, ["add", "--", "operator-notes.txt"]);
      },
    });

    expect(committed.committed).toBe(true);
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("operator-notes.txt");
    expect(() => git(root, ["show", "HEAD:operator-notes.txt"])).toThrow();
    await completeDecompositionTransactionJournal(adapter, prepared.journalPath, prepared.journal);
  });

  test.each([
    "ref_updated",
    "commit_verified",
    "index_published",
    "index_directory_flushed",
    "index_lock_removed",
    "journal_directory_flushed",
  ] as const)("returns committed success after a fault at %s", async (faultStep) => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();

    const committed = await commitDecompositionTransaction(adapter, prepared.journal, {
      afterPostCommitStep: (step) => {
        if (step === faultStep) throw new Error(`synthetic crash after ${step}`);
      },
    });

    expect(committed).toMatchObject({
      committed: true,
      sha: prepared.journal.commitSha?.slice(0, 7),
      journalReconciled: true,
      warnings: [expect.stringContaining(`synthetic crash after ${faultStep}`)],
    });
    expect(git(root, ["status", "--porcelain", "--", "docs/tasks"])).toBe("");
    await expect(fs.access(prepared.journalPath)).rejects.toThrow();
    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([]);
  });

  test("returns committed success without a post-publication Git lookup", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();
    const originalPath = process.env.PATH;

    let committed: Awaited<ReturnType<typeof commitDecompositionTransaction>>;
    try {
      committed = await commitDecompositionTransaction(adapter, prepared.journal, {
        afterIndexPublish: () => {
          process.env.PATH = "";
        },
      });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(committed).toMatchObject({
      committed: true,
      sha: prepared.journal.commitSha?.slice(0, 7),
    });
    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "committed_reconciled" }),
    ]);
    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([]);
  });

  test("recognizes the journaled decomposition commit beneath a later unrelated commit", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    await writeChildren();
    await commitDecompositionTransaction(adapter, prepared.journal);
    await fs.writeFile(path.join(root, "later.txt"), "later commit\n", "utf-8");
    git(root, ["add", "--", "later.txt"]);
    git(root, ["commit", "-q", "-m", "later unrelated commit"]);

    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "committed_reconciled" }),
    ]);
    expect(git(root, ["log", "-1", "--format=%s"])).toBe("later unrelated commit");
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentTarget);
  });

  test("refuses an identical but unowned Git index lock", async () => {
    const prepared = await prepareJournal();
    const gitDirectory = git(root, ["rev-parse", "--absolute-git-dir"]);
    const indexPath = path.join(gitDirectory, "index");
    const lockPath = `${indexPath}.lock`;
    await fs.copyFile(indexPath, lockPath);

    await expect(recoverPendingDecompositionTransactions(adapter)).rejects.toThrow(
      "does not own the current Git index lock",
    );
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
  });

  test("discards a partial private index only when the owned baseline lock is intact", async () => {
    const prepared = await prepareJournal();
    const gitDirectory = git(root, ["rev-parse", "--absolute-git-dir"]);
    const indexPath = path.join(gitDirectory, "index");
    const lockPath = `${indexPath}.lock`;
    const candidatePath = path.join(
      gitDirectory,
      "quack",
      "decomposition-transactions",
      ".real-index-TASK-006",
    );
    await fs.link(indexPath, lockPath);
    await fs.copyFile(indexPath, candidatePath);
    execFileSync(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${prepared.journal.parent.targetMode},${prepared.journal.parent.targetGitBlob},${prepared.journal.parent.relativePath}`,
      ],
      {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: candidatePath },
      },
    );

    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "rolled_back" }),
    ]);
    await expect(fs.access(lockPath)).rejects.toThrow();
    await expect(fs.access(candidatePath)).rejects.toThrow();
  });

  test("verifies a committed CRLF transaction using Git clean-filter blob semantics", async () => {
    git(root, ["config", "core.autocrlf", "true"]);
    parentOriginal = taskMarkdown("TASK-006", "Journal parent", "READY").replace(/\n/g, "\r\n");
    parentTarget = taskMarkdown("TASK-006", "Journal parent", "DECOMPOSED").replace(/\n/g, "\r\n");
    await fs.writeFile(parentPath, parentOriginal, "utf-8");
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    const childPaths = await writeChildren();
    const transactionPaths = [
      "docs/tasks/TASK-006-journal-parent.md",
      ...childPaths.map((item) => path.relative(root, item).replace(/\\/g, "/")),
    ];
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "committing",
    );
    git(root, ["add", "--", ...transactionPaths]);
    git(root, ["commit", "-q", "--only", "-m", "decomposition CRLF", "--", ...transactionPaths]);

    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "committed_reconciled" }),
    ]);
    await expect(fs.access(prepared.journalPath)).rejects.toThrow();
    expect(git(root, ["status", "--porcelain", "--", ...transactionPaths])).toBe("");
  });

  test("retains the journal and refuses to overwrite divergent worktree bytes", async () => {
    const prepared = await prepareJournal();
    await fs.writeFile(parentPath, `${parentTarget}\noperator divergence\n`, "utf-8");

    await expect(recoverPendingDecompositionTransactions(adapter)).rejects.toThrow(
      "Parent bytes diverged",
    );
    expect(await fs.readFile(parentPath, "utf-8")).toContain("operator divergence");
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
  });

  test("rejects a journal with a malicious escaping path and leaves outside bytes untouched", async () => {
    const prepared = await prepareJournal();
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "operator-owned\n", "utf-8");
    const raw = JSON.parse(await fs.readFile(prepared.journalPath, "utf-8")) as {
      children: Array<{ relativePath: string }>;
    };
    raw.children[0].relativePath = "../outside.md";
    await fs.writeFile(prepared.journalPath, `${JSON.stringify(raw)}\n`, "utf-8");

    await expect(recoverPendingDecompositionTransactions(adapter)).rejects.toThrow(
      "Malformed child entry",
    );
    expect(await fs.readFile(outside, "utf-8")).toBe("operator-owned\n");
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
  });

  test("refuses an existing child destination before journaling or mutating the parent", async () => {
    const collision = planSubtaskSpecWrites(drafts, adapter)[0].filePath;
    await fs.writeFile(collision, "operator-owned\n", "utf-8");

    await expect(prepareJournal()).rejects.toThrow("Child worktree destination already exists");
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
    expect(await fs.readFile(collision, "utf-8")).toBe("operator-owned\n");
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, "TASK-006")),
    ).rejects.toThrow();
  });

  test("refuses an unowned atomic-write temporary path before publishing a journal", async () => {
    const temporaryPath = decompositionTemporaryPath(parentPath);
    await fs.writeFile(temporaryPath, "operator-owned temporary bytes\n", "utf-8");

    await expect(prepareJournal()).rejects.toThrow(
      "transaction temporary destination already exists",
    );
    expect(await fs.readFile(temporaryPath, "utf-8")).toBe("operator-owned temporary bytes\n");
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
    await expect(
      fs.access(await decompositionJournalPathForTask(adapter, "TASK-006")),
    ).rejects.toThrow();
  });

  test("retries transient Windows cleanup failure for an unpublished journal temp", async () => {
    if (process.platform !== "win32") return;
    const journalPath = await decompositionJournalPathForTask(adapter, "TASK-006");
    const mutableFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalRename = mutableFs.rename;
    const originalUnlink = mutableFs.unlink;
    let transientFailureInjected = false;
    const renameSpy = jest.spyOn(mutableFs, "rename").mockImplementation(async (...args) => {
      if (path.resolve(String(args[1])) === path.resolve(journalPath)) {
        throw new Error("synthetic journal publication failure");
      }
      return originalRename(...args);
    });
    const unlinkSpy = jest.spyOn(mutableFs, "unlink").mockImplementation(async (...args) => {
      if (!transientFailureInjected && String(args[0]).startsWith(`${journalPath}.tmp-`)) {
        transientFailureInjected = true;
        const error = new Error("synthetic Windows sharing violation") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalUnlink(...args);
    });

    try {
      await expect(prepareJournal()).rejects.toThrow("synthetic journal publication failure");
      expect(transientFailureInjected).toBe(true);
      expect(
        unlinkSpy.mock.calls.filter((args) => String(args[0]).startsWith(`${journalPath}.tmp-`)),
      ).toHaveLength(2);
      expect(
        (await fs.readdir(path.dirname(journalPath))).filter((name) =>
          name.includes(`${path.basename(journalPath)}.tmp-`),
        ),
      ).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  test("accepts a tracked parent whose exact unstaged worktree bytes differ from HEAD", async () => {
    parentOriginal = `${parentOriginal}\n<!-- unstaged operator context -->\n`;
    parentTarget = `${parentTarget}\n<!-- unstaged operator context -->\n`;
    await fs.writeFile(parentPath, parentOriginal, "utf-8");

    const prepared = await prepareJournal();
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "rolled_back" }),
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
  });

  test("accepts an untracked parent while preserving its exact original bytes on recovery", async () => {
    git(root, ["rm", "-q", "--cached", "--", "docs/tasks/TASK-006-journal-parent.md"]);
    git(root, ["commit", "-q", "-m", "untrack parent"]);

    const prepared = await prepareJournal();
    await fs.writeFile(parentPath, parentTarget, "utf-8");
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "parent_written",
    );
    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "rolled_back" }),
    ]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
    expect(git(root, ["ls-files", "--", "docs/tasks/TASK-006-journal-parent.md"])).toBe("");
  });

  test("holds dispatch admission until an in-flight decomposition releases and recovers", async () => {
    let releaseWriter!: () => void;
    const writerHeld = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let journalPrepared!: () => void;
    const preparedSignal = new Promise<void>((resolve) => {
      journalPrepared = resolve;
    });
    const taskDir = path.join(root, "docs", "tasks");
    const writer = withTaskCreationReservation(
      taskDir,
      { creator: "decompose", requestedIds: ["TASK-006"] },
      async () => {
        const prepared = await prepareJournal();
        await fs.writeFile(parentPath, parentTarget, "utf-8");
        await updateDecompositionTransactionJournal(
          prepared.journalPath,
          prepared.journal,
          "parent_written",
        );
        journalPrepared();
        await writerHeld;
      },
    );
    await preparedSignal;

    const dispatch = jest.fn(() => "started");
    const admission = withDecompositionAdmissionFence(adapter, "TASK-006", dispatch);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dispatch).not.toHaveBeenCalled();

    releaseWriter();
    await writer;
    await expect(admission).resolves.toBe("started");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      taskId: "TASK-006",
      fileName: path.basename(parentPath),
      contentHash: createHash("sha256").update(parentOriginal).digest("hex"),
    });
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
  });

  test("recovers an interrupted decomposition before another task-spec creator writes", async () => {
    const prepared = await prepareJournal();
    await fs.writeFile(parentPath, parentTarget, "utf-8");
    const [partialChild] = await writeChildren(1);
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "parent_written",
    );

    const nextTask = taskMarkdown("TASK-007", "Independent planner task", "READY");
    const result = await writeTaskFilesWithResult([{ id: "TASK-007", content: nextTask }], adapter);

    expect(result.taskIds).toEqual(["TASK-007"]);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
    await expect(fs.access(partialChild)).rejects.toThrow();
    await expect(fs.access(prepared.journalPath)).rejects.toThrow();
  });

  test("refuses to dispatch a parent that is DECOMPOSED at the reserved admission boundary", async () => {
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    const dispatch = jest.fn(() => "started");

    await expect(withDecompositionAdmissionFence(adapter, "TASK-006", dispatch)).rejects.toThrow(
      "parent spec is DECOMPOSED",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("refuses a differently named duplicate claimant discovered under the reservation", async () => {
    await fs.writeFile(
      path.join(root, "docs", "tasks", "operator-copy.md"),
      parentOriginal,
      "utf-8",
    );
    const dispatch = jest.fn(() => "started");

    await expect(withDecompositionAdmissionFence(adapter, "TASK-006", dispatch)).rejects.toThrow(
      "has duplicate claimants",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("publishes only complete bytes while the no-clobber pathname claim is in flight", async () => {
    const target = `${parentTarget}\n${"durable-target\n".repeat(100_000)}`;
    let settled = false;
    const replacing = writeDecompositionFileAtomicReplace(
      parentPath,
      target,
      parentOriginal,
    ).finally(() => {
      settled = true;
    });
    const observed: string[] = [];
    while (!settled && observed.length < 100) {
      try {
        observed.push(await fs.readFile(parentPath, "utf-8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await replacing;

    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((bytes) => bytes === parentOriginal || bytes === target)).toBe(true);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(target);
  });

  test("refuses an identical-byte inode swap at the final replacement fence", async () => {
    const mutableFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalLstat = mutableFs.lstat;
    let destinationStats = 0;
    const lstatSpy = jest.spyOn(mutableFs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (path.resolve(String(args[0])) !== path.resolve(parentPath)) return stat;
      destinationStats += 1;
      if (destinationStats !== 2) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "ino") return BigInt(target.ino) + 1n;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    });

    try {
      await expect(
        writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal),
      ).rejects.toThrow("changed file identity");
      expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  test("uses a unique replacement temp so a stale legacy temp cannot wedge canonical writes", async () => {
    const staleTemporaryPath = decompositionTemporaryPath(parentPath);
    await fs.writeFile(staleTemporaryPath, "operator-owned legacy temp\n", "utf-8");

    await expect(
      writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentTarget);
    expect(await fs.readFile(staleTemporaryPath, "utf-8")).toBe("operator-owned legacy temp\n");
  });

  test("publishes exactly one complete child when two exclusive writers race", async () => {
    const destination = path.join(root, "docs", "tasks", "TASK-006-C-race.md");
    const first = `first\n${"A".repeat(2_000_000)}`;
    const second = `second\n${"B".repeat(2_000_000)}`;

    const outcomes = await Promise.allSettled([
      writeDecompositionFileAtomicExclusive(destination, first),
      writeDecompositionFileAtomicExclusive(destination, second),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect([first, second]).toContain(await fs.readFile(destination, "utf-8"));
    expect(
      (await fs.readdir(path.dirname(destination))).filter((name) =>
        name.includes(".quack-decompose-tmp"),
      ),
    ).toEqual([]);
  });

  test("rolls back an exclusively published child when a post-link durability step fails", async () => {
    const destination = path.join(root, "docs", "tasks", "TASK-006-C-fsync-failure.md");
    const mutableFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalOpen = mutableFs.open;
    const openSpy = jest.spyOn(mutableFs, "open").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(destination) && args[1] === "r+") {
        throw new Error("synthetic post-link fsync failure");
      }
      return originalOpen(...args);
    });
    try {
      await expect(
        writeDecompositionFileAtomicExclusive(destination, "complete child bytes\n"),
      ).rejects.toThrow("synthetic post-link fsync failure");
      await expect(fs.access(destination)).rejects.toThrow();
      expect(
        (await fs.readdir(path.dirname(destination))).filter((name) =>
          name.includes(".quack-decompose-tmp"),
        ),
      ).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("removes the transaction-owned hard-link orphan after a crash during child publish", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    const childPath = planSubtaskSpecWrites(drafts, adapter)[0].filePath;
    const temporaryPath = decompositionTemporaryPath(childPath);
    await fs.writeFile(temporaryPath, drafts[0].markdown, "utf-8");
    await fs.link(temporaryPath, childPath);
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "parent_written",
    );

    await expect(recoverPendingDecompositionTransactions(adapter)).resolves.toEqual([
      expect.objectContaining({ outcome: "rolled_back" }),
    ]);
    await expect(fs.access(childPath)).rejects.toThrow();
    await expect(fs.access(temporaryPath)).rejects.toThrow();
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentOriginal);
  });

  test("refuses to delete a child that has an unrelated external hard link", async () => {
    const prepared = await prepareJournal();
    await writeDecompositionFileAtomicReplace(parentPath, parentTarget, parentOriginal);
    const childPath = planSubtaskSpecWrites(drafts, adapter)[0].filePath;
    const externalLink = path.join(root, "operator-child-link.md");
    await fs.writeFile(childPath, drafts[0].markdown, "utf-8");
    await fs.link(childPath, externalLink);
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "parent_written",
    );

    await expect(recoverPendingDecompositionTransactions(adapter)).rejects.toThrow(
      "single-link regular file",
    );
    expect(await fs.readFile(childPath, "utf-8")).toBe(drafts[0].markdown);
    expect(await fs.readFile(externalLink, "utf-8")).toBe(drafts[0].markdown);
    expect(await fs.readFile(parentPath, "utf-8")).toBe(parentTarget);
    await expect(fs.access(prepared.journalPath)).resolves.toBeUndefined();
  });

  test("derives the journal directory from a linked worktree's private Git directory", async () => {
    const worktreeContainer = await fs.mkdtemp(path.join(os.tmpdir(), "quack-journal-worktree-"));
    const linkedRoot = path.join(worktreeContainer, "linked");
    git(root, ["worktree", "add", "-q", "-b", "journal-linked", linkedRoot, "HEAD"]);

    try {
      const linkedAdapter = adapterFor(linkedRoot);
      const worktreeGitDirectory = await fs.realpath(
        git(linkedRoot, ["rev-parse", "--absolute-git-dir"]),
      );
      const mainGitDirectory = await fs.realpath(path.join(root, ".git"));
      const journalPath = await decompositionJournalPathForTask(linkedAdapter, "TASK-006");

      expect(worktreeGitDirectory).not.toBe(mainGitDirectory);
      expect(path.dirname(journalPath)).toBe(
        path.join(worktreeGitDirectory, "quack", "decomposition-transactions"),
      );
    } finally {
      git(root, ["worktree", "remove", "--force", linkedRoot]);
      await fs.rm(worktreeContainer, { recursive: true, force: true });
    }
  });

  test("rejects a symlink or junction that redirects the Git-private journal chain", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "quack-journal-outside-"));
    const gitDirectory = await fs.realpath(git(root, ["rev-parse", "--absolute-git-dir"]));
    const redirectedComponent = path.join(gitDirectory, "quack");
    const supported = await tryCreateDirectoryRedirect(outside, redirectedComponent);
    if (!supported) {
      await fs.rm(outside, { recursive: true, force: true });
      return;
    }

    try {
      await expect(prepareJournal()).rejects.toThrow(
        "Git-private journal path component is not a real directory",
      );
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.unlink(redirectedComponent).catch(() => undefined);
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a non-directory component in the Git-private journal chain", async () => {
    const gitDirectory = await fs.realpath(git(root, ["rev-parse", "--absolute-git-dir"]));
    const invalidComponent = path.join(gitDirectory, "quack");
    await fs.writeFile(invalidComponent, "not a directory\n", "utf-8");

    await expect(prepareJournal()).rejects.toThrow(
      "Git-private journal path component is not a real directory",
    );
  });
});
