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
    await writeTaskFile(
      taskDir,
      "TASK-758-example.md",
      ["# TASK-758: Example", "## Metadata", "- **Status:** READY"].join("\n"),
    );
    await writeTaskFile(
      taskDir,
      "TASK-584-example.md",
      ["# TASK-584: Example", "## Metadata", "- **Status:** READY", "- **On Hold:** true"].join(
        "\n",
      ),
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
    await writeTaskFile(
      taskDir,
      "TASK-758-example.md",
      ["# TASK-758: Example", "## Metadata", "- **Status:** READY"].join("\n"),
    );

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
