import { afterEach, describe, expect, test } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { TaskStatusRow } from "../../src/db/types.js";
import {
  parseSpecStatus,
  reconcileSpecStatuses,
} from "../../src/scripts/reconcile-spec-status-lib.js";

const tempRoots: string[] = [];

async function makeProject(): Promise<{ root: string; taskDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-reconcile-status-"));
  tempRoots.push(root);
  const taskDir = path.join(root, "docs", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.mkdir(path.join(root, ".quack"), { recursive: true });
  return { root, taskDir };
}

async function writeTaskFile(taskDir: string, fileName: string, content: string): Promise<void> {
  await fs.writeFile(path.join(taskDir, fileName), content, "utf-8");
}

function taskSpec(taskId: string, status: string, extraMetadata: string[] = []): string {
  return [
    `# ${taskId}: Example`,
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    ...extraMetadata,
    "",
    "## Problem Statement",
    "Exercise canonical status reconciliation.",
    "",
    "## Success Criteria",
    "- [x] Status is reconciled.",
    "",
    "## Testing Requirements",
    "- [x] The fixture is covered.",
  ].join("\n");
}

function makeStatus(taskId: string, status: string): TaskStatusRow {
  return {
    task_id: taskId,
    status,
    updated_at: new Date().toISOString(),
    updated_by: "test",
    previous_status: null,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("parseSpecStatus", () => {
  test("parses status and On Hold metadata", () => {
    const parsed = parseSpecStatus(
      ["# TASK-584: Example", "## Metadata", "- **Status:** READY", "- **On Hold:** true"].join(
        "\n",
      ),
    );

    expect(parsed.status).toBe("READY");
    expect(parsed.onHold).toBe(true);
    expect(parsed.statusLine).toContain("**Status:** READY");
  });
});

describe("reconcileSpecStatuses", () => {
  test("reports drift, missing specs, and skips valid On Hold rows in dry-run mode", async () => {
    const { taskDir } = await makeProject();
    await writeTaskFile(taskDir, "TASK-758-example.md", taskSpec("TASK-758", "READY"));
    await writeTaskFile(
      taskDir,
      "TASK-584-example.md",
      taskSpec("TASK-584", "READY", ["- **On Hold:** true"]),
    );
    await writeTaskFile(
      taskDir,
      "TASK-900-example.md",
      ["# TASK-900: Example", "## Metadata", "- **Priority:** P1-HIGH"].join("\n"),
    );

    const result = await reconcileSpecStatuses(taskDir, [
      makeStatus("TASK-758", "COMPLETE"),
      makeStatus("TASK-584", "ON_HOLD"),
      makeStatus("TASK-900", "COMPLETE"),
      makeStatus("TASK-999", "COMPLETE"),
    ]);

    expect(result.skippedOnHold).toEqual(["TASK-584"]);
    expect(result.drift).toEqual([
      expect.objectContaining({
        taskId: "TASK-758",
        dbStatus: "COMPLETE",
        specStatus: "READY",
        reason: "status_mismatch",
      }),
      expect.objectContaining({
        taskId: "TASK-900",
        dbStatus: "COMPLETE",
        specStatus: null,
        reason: "missing_status_line",
      }),
      expect.objectContaining({
        taskId: "TASK-999",
        dbStatus: "COMPLETE",
        specStatus: null,
        reason: "missing_spec",
      }),
    ]);
    expect(result.fixed).toEqual([]);
    expect(result.failedToFix).toEqual([]);
  });

  test("apply mode rewrites mismatched spec statuses and reports failures for missing specs", async () => {
    const { taskDir } = await makeProject();
    await writeTaskFile(taskDir, "TASK-758-example.md", taskSpec("TASK-758", "READY"));

    const result = await reconcileSpecStatuses(
      taskDir,
      [makeStatus("TASK-758", "COMPLETE"), makeStatus("TASK-999", "COMPLETE")],
      { apply: true },
    );

    const updated = await fs.readFile(path.join(taskDir, "TASK-758-example.md"), "utf-8");

    expect(updated).toContain("**Status:** COMPLETE");
    expect(result.fixed).toEqual(["TASK-758"]);
    expect(result.failedToFix).toEqual(["TASK-999"]);
  });
});

// TASK-1336-C: H1-level reconciliation deliberately retains partial specs.
describe.each(["forward", "reverse"])("declared spec reconciliation (%s)", (order) => {
  test("drift lookup and apply use the declared task despite swapped filename identities", async () => {
    const { taskDir } = await makeProject();
    const entries = [
      ["TASK-100-first.md", taskSpec("TASK-200", "READY")],
      ["TASK-200-second.md", taskSpec("TASK-100", "COMPLETE")],
    ];
    for (const [name, content] of order === "forward" ? entries : [...entries].reverse())
      await writeTaskFile(taskDir, name, content);
    const untouched = await fs.readFile(path.join(taskDir, "TASK-200-second.md"), "utf8");
    const result = await reconcileSpecStatuses(taskDir, [makeStatus("TASK-200", "COMPLETE")], {
      apply: true,
    });
    expect(result.drift).toEqual([
      expect.objectContaining({
        taskId: "TASK-200",
        specPath: path.join(taskDir, "TASK-100-first.md"),
        reason: "status_mismatch",
      }),
    ]);
    expect(result.fixed).toEqual(["TASK-200"]);
    expect(await fs.readFile(path.join(taskDir, "TASK-100-first.md"), "utf8")).toContain(
      "**Status:** COMPLETE",
    );
    expect(await fs.readFile(path.join(taskDir, "TASK-200-second.md"), "utf8")).toBe(untouched);
  });
  test("indexes partial and explicit legacy H1 families without admitting absent or malformed declarations", async () => {
    const { taskDir } = await makeProject();
    const ids = ["TASK-1402-A", "SAURUS-REM-001", "TASK-BS-01", "TASK-SAURUS-REM-001"];
    const entries = ids.map((id, index) => [
      `TASK-${index + 1}-divergent.md`,
      `# ${id}: partial\n## Metadata\n- **Status:** READY\n`,
    ]);
    entries.push(["TASK-9000-no-heading.md", "- **Status:** READY\n"]);
    entries.push([
      "TASK-9001-malformed-heading.md",
      "# Not a task\n# TASK-9001: ignored second H1\n- **Status:** READY\n",
    ]);
    for (const [name, content] of order === "forward" ? entries : [...entries].reverse())
      await writeTaskFile(taskDir, name, content);
    const result = await reconcileSpecStatuses(
      taskDir,
      [...ids, "TASK-9000", "TASK-9001", "TASK-9002"].map((id) => makeStatus(id, "COMPLETE")),
    );
    expect(
      result.drift
        .filter((item) => item.reason === "status_mismatch")
        .map((item) => item.taskId)
        .sort(),
    ).toEqual([...ids].sort());
    expect(
      result.drift.filter((item) => item.reason === "missing_spec").map((item) => item.taskId),
    ).toEqual(["TASK-9000", "TASK-9001", "TASK-9002"]);
  });
});
