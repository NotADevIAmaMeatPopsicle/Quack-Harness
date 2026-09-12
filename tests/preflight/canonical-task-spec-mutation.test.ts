import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import {
  CanonicalTaskSpecMutationError,
  withCanonicalTaskSpecMutationFence,
} from "../../src/preflight/canonical-task-spec-mutation";
import {
  createCanonicalTaskMutationJournal,
  recoverPendingCanonicalTaskMutationsWithinReservation,
} from "../../src/preflight/canonical-task-mutation-journal";
import {
  decompositionReplacementBackupPath,
  decompositionTemporaryPath,
} from "../../src/preflight/decomposition-file-io";

function adapterFor(projectRoot: string): ProjectAdapter {
  const config = {
    project: { name: "mutation-test", root: ".", taskDir: "docs/tasks" },
  } as AdapterConfig;
  return { projectRoot, config } as ProjectAdapter;
}

function spec(status: "READY" | "BACKLOG" | "REJECTED" | "DECOMPOSED"): string {
  return [
    "# TASK-006: Mutation fixture",
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** mutation",
    "",
    "## Problem Statement",
    "Protect this canonical spec from stale or decomposition-racing writes.",
    "",
    "## Success Criteria",
    "- [ ] The exact current bytes are checked under the shared reservation",
    "",
    "## Testing Requirements",
    "- [ ] Exercise stale and decomposed refusals",
    "",
  ].join("\n");
}

describe("canonical task-spec mutation fence", () => {
  let root: string;
  let taskFilePath: string;
  let adapter: ProjectAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-task-mutation-"));
    await fs.mkdir(path.join(root, "docs", "tasks"), { recursive: true });
    await fs.mkdir(path.join(root, ".quack"), { recursive: true });
    taskFilePath = path.join(root, "docs", "tasks", "TASK-006-fixture.md");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "quack-test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: root });
    adapter = adapterFor(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("publishes an exact-identity replacement after the locked CAS", async () => {
    const original = spec("READY");
    const replacement = spec("REJECTED");
    await fs.writeFile(taskFilePath, original, "utf-8");

    await expect(
      withCanonicalTaskSpecMutationFence({
        adapter,
        taskId: "TASK-006",
        taskFilePath,
        expectedContent: original,
        replacementContent: replacement,
      }),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(replacement);
  });

  test("publishes a journaled canonical replacement in a non-Git project", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
    const original = spec("READY");
    const replacement = spec("REJECTED");
    await fs.writeFile(taskFilePath, original, "utf-8");

    await expect(
      withCanonicalTaskSpecMutationFence({
        adapter,
        taskId: "TASK-006",
        taskFilePath,
        expectedContent: original,
        replacementContent: replacement,
      }),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(replacement);
    expect(await fs.readdir(path.join(root, ".quack", "cache", "canonical-mutations"))).toEqual([]);
  });

  test("refuses a stale expected snapshot without overwriting newer bytes", async () => {
    const stale = spec("READY");
    const current = `${stale}\n<!-- operator edit -->\n`;
    await fs.writeFile(taskFilePath, current, "utf-8");

    await expect(
      withCanonicalTaskSpecMutationFence({
        adapter,
        taskId: "TASK-006",
        taskFilePath,
        expectedContent: stale,
        replacementContent: spec("REJECTED"),
      }),
    ).rejects.toMatchObject<Partial<CanonicalTaskSpecMutationError>>({ code: "task_changed" });
    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(current);
  });

  test("refuses to overwrite a finalized DECOMPOSED parent", async () => {
    const decomposed = spec("DECOMPOSED");
    await fs.writeFile(taskFilePath, decomposed, "utf-8");

    await expect(
      withCanonicalTaskSpecMutationFence({
        adapter,
        taskId: "TASK-006",
        taskFilePath,
        expectedContent: decomposed,
        replacementContent: spec("REJECTED"),
      }),
    ).rejects.toMatchObject<Partial<CanonicalTaskSpecMutationError>>({
      code: "task_decomposed",
    });
    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(decomposed);
  });

  test("rejects attempts to manufacture DECOMPOSED outside the finalizer", async () => {
    const original = spec("READY");
    await fs.writeFile(taskFilePath, original, "utf-8");

    await expect(
      withCanonicalTaskSpecMutationFence({
        adapter,
        taskId: "TASK-006",
        taskFilePath,
        expectedContent: original,
        replacementContent: spec("DECOMPOSED"),
      }),
    ).rejects.toMatchObject<Partial<CanonicalTaskSpecMutationError>>({ code: "task_invalid" });
    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(original);
  });

  test("recovers a crash after claiming the canonical pathname", async () => {
    const original = spec("READY");
    const replacement = spec("REJECTED");
    await fs.writeFile(taskFilePath, original, "utf-8");
    const journalPath = await createCanonicalTaskMutationJournal({
      adapter,
      taskId: "TASK-006",
      taskFilePath,
      originalContent: original,
      targetContent: replacement,
    });
    const backupPath = decompositionReplacementBackupPath(taskFilePath);
    await fs.rename(taskFilePath, backupPath);
    await fs.writeFile(decompositionTemporaryPath(taskFilePath), replacement, "utf-8");

    await recoverPendingCanonicalTaskMutationsWithinReservation(adapter);

    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(original);
    await expect(fs.access(backupPath)).rejects.toThrow();
    await expect(fs.access(decompositionTemporaryPath(taskFilePath))).rejects.toThrow();
    await expect(fs.access(journalPath)).rejects.toThrow();
  });

  test("recovers a non-Git canonical mutation from its project-local journal", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });
    const original = spec("READY");
    const replacement = spec("REJECTED");
    await fs.writeFile(taskFilePath, original, "utf-8");
    const journalPath = await createCanonicalTaskMutationJournal({
      adapter,
      taskId: "TASK-006",
      taskFilePath,
      originalContent: original,
      targetContent: replacement,
    });
    const backupPath = decompositionReplacementBackupPath(taskFilePath);
    await fs.rename(taskFilePath, backupPath);
    await fs.writeFile(decompositionTemporaryPath(taskFilePath), replacement, "utf-8");

    await recoverPendingCanonicalTaskMutationsWithinReservation(adapter);

    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(original);
    await expect(fs.access(backupPath)).rejects.toThrow();
    await expect(fs.access(decompositionTemporaryPath(taskFilePath))).rejects.toThrow();
    await expect(fs.access(journalPath)).rejects.toThrow();
  });

  test("completes recovery after target publication and removes its hard-link temp", async () => {
    const original = spec("READY");
    const replacement = spec("REJECTED");
    await fs.writeFile(taskFilePath, original, "utf-8");
    const journalPath = await createCanonicalTaskMutationJournal({
      adapter,
      taskId: "TASK-006",
      taskFilePath,
      originalContent: original,
      targetContent: replacement,
    });
    const backupPath = decompositionReplacementBackupPath(taskFilePath);
    const temporaryPath = decompositionTemporaryPath(taskFilePath);
    await fs.rename(taskFilePath, backupPath);
    await fs.writeFile(temporaryPath, replacement, "utf-8");
    await fs.link(temporaryPath, taskFilePath);

    await recoverPendingCanonicalTaskMutationsWithinReservation(adapter);

    expect(await fs.readFile(taskFilePath, "utf-8")).toBe(replacement);
    await expect(fs.access(backupPath)).rejects.toThrow();
    await expect(fs.access(temporaryPath)).rejects.toThrow();
    await expect(fs.access(journalPath)).rejects.toThrow();
  });
});
