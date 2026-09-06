import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  pickBestRawTaskFileCandidate,
  resolveParsedTaskFile,
  resolveTaskFile,
} from "../../src/core/task-file-resolver";

describe("task-file-resolver", () => {
  let tmpDir: string;
  let taskDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-task-file-"));
    taskDir = path.join(tmpDir, "docs", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("pickBestRawTaskFileCandidate prefers the parent task over a subtask prefix match", () => {
    const match = pickBestRawTaskFileCandidate("TASK-826", [
      "TASK-826-A-docker-teardown-warning-fix.md",
      "TASK-826-worktree-docker-cleanup-hook.md",
    ]);

    expect(match).toBe("TASK-826-worktree-docker-cleanup-hook.md");
  });

  test("resolveParsedTaskFile prefers the parent task when a subtask shares the prefix", async () => {
    await fs.writeFile(
      path.join(taskDir, "TASK-826-worktree-docker-cleanup-hook.md"),
      [
        "# TASK-826: Parent Task",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 2-4 hours",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** infrastructure",
        "",
        "## Problem Statement",
        "Parent task.",
        "",
        "## Success Criteria",
        "- Parent works",
        "",
        "## Testing Requirements",
        "- Unit tests",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(taskDir, "TASK-826-A-docker-teardown-warning-fix.md"),
      [
        "# TASK-826-A: Subtask",
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1 hour",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** infrastructure",
        "",
        "## Problem Statement",
        "Subtask.",
        "",
        "## Success Criteria",
        "- Subtask works",
        "",
        "## Testing Requirements",
        "- Unit tests",
      ].join("\n"),
    );

    const resolved = await resolveParsedTaskFile(taskDir, "TASK-826");

    expect(resolved?.filePath).toContain("TASK-826-worktree-docker-cleanup-hook.md");
    expect(resolved?.task?.id).toBe("TASK-826");
  });

  test("resolveTaskFile falls back to the canonical parent file when parsing fails", async () => {
    await fs.writeFile(
      path.join(taskDir, "TASK-826-worktree-docker-cleanup-hook.md"),
      "# broken parent spec",
    );
    await fs.writeFile(
      path.join(taskDir, "TASK-826-A-docker-teardown-warning-fix.md"),
      "# broken subtask spec",
    );

    const resolved = await resolveTaskFile(taskDir, "TASK-826");

    expect(resolved?.filePath).toContain("TASK-826-worktree-docker-cleanup-hook.md");
    expect(resolved?.task).toBeNull();
  });
});
