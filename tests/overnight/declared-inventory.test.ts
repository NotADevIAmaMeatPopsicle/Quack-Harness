// TASK-1336-B: real files and real local Git refs. Inventory-only runs use
// maxCycles:0, so they do not contact a monitor, provider or remote repository.
import * as fs from "node:fs";
import * as path from "node:path";
import { runOvernightRunner } from "../../src/overnight/runner";
import { createDeclaredParentFixture } from "../helpers/declared-parent-fixture";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe.each(["forward", "reverse"] as const)(
  "TASK-1336-B overnight declaration inventory (%s)",
  (order) => {
    let fixture: ReturnType<typeof createDeclaredParentFixture>;
    beforeEach(() => {
      fixture = createDeclaredParentFixture(order);
    });
    afterEach(() => fixture.cleanup());

    it("keeps child parse errors off the valid parent and preserves the child's error", async () => {
      const result = await runOvernightRunner({
        projectRoot: fixture.root,
        taskIds: ["TASK-100", "TASK-100-C"],
        maxCycles: 0,
        haltOnParseErrors: false,
        dryRun: true,
        federationDispatch: false,
        logger() {},
      });
      expect(result.tasks.find((task) => task.taskId === "TASK-100")).toEqual(
        expect.objectContaining({ status: "pending_prep", taskFile: fixture.parentPath }),
      );
      expect(result.tasks.find((task) => task.taskId === "TASK-100")?.lastError).toBeUndefined();
      expect(result.tasks.find((task) => task.taskId === "TASK-100-C")).toEqual(
        expect.objectContaining({
          status: "manual_review",
          failureClass: "parse_error",
        }),
      );
      expect(result.tasks.find((task) => task.taskId === "TASK-100-C")?.lastError).toContain(
        "Priority",
      );
    });

    it("keeps a no-H1 child on its canonical raw file and exposes the named global parse record", async () => {
      fs.writeFileSync(fixture.malformedPath, "Parent Task: TASK-100\nmissing H1\n");
      const result = await runOvernightRunner({
        projectRoot: fixture.root,
        taskIds: ["TASK-100", "TASK-100-C"],
        maxCycles: 1,
        haltOnParseErrors: true,
        dryRun: true,
        federationDispatch: false,
        logger() {},
      });
      expect(result.halted).toBe(true);
      expect(result.haltReason).toContain("task parse errors present");
      expect(result.tasks.find((task) => task.taskId === "TASK-100")?.status).toBe("pending_prep");
      expect(result.tasks.find((task) => task.taskId === "TASK-100-C")?.lastError).toContain(
        "Missing required H1",
      );
      expect(JSON.stringify(result.events)).toContain(path.basename(fixture.malformedPath));
      expect(JSON.stringify(result.events)).toContain("Missing required H1");
    });

    it("uses source-ref declarations and skips named malformed or deleted blobs", async () => {
      fixture.git(["switch", "-c", "source-fixture"]);
      const changedPath = "docs/tasks/TASK-7777-source-only.md";
      const secondPath = "docs/tasks/TASK-0001-second-source.md";
      const malformedPath = "docs/tasks/TASK-8888-malformed-source.md";
      fs.writeFileSync(
        path.join(fixture.root, changedPath),
        taskSpec("TASK-2400", { status: "COMPLETE", title: "Source branch declaration" }),
      );
      fs.writeFileSync(
        path.join(fixture.root, secondPath),
        taskSpec("TASK-2500", { status: "COMPLETE", title: "Second source declaration" }),
      );
      fs.writeFileSync(
        path.join(fixture.root, malformedPath),
        "# TASK-8888: no required sections\n",
      );
      fs.unlinkSync(fixture.secondPath);
      fixture.git(["add", "."]);
      fixture.git(["commit", "-m", "Source declarations"]);
      fixture.git(["switch", "main"]);
      // A current-tree decoy proves the inventory reads the source ref, not disk.
      fs.writeFileSync(
        path.join(fixture.root, changedPath),
        taskSpec("TASK-9999", { status: "COMPLETE", title: "Current tree decoy" }),
      );
      const logs: string[] = [];
      const result = await runOvernightRunner({
        projectRoot: fixture.root,
        sourceBranch: "source-fixture",
        targetBranch: "main",
        maxCycles: 0,
        dryRun: true,
        federationDispatch: false,
        logger: (message) => logs.push(message),
      });
      expect(result.tasks.map((task) => task.taskId)).toEqual(["TASK-2400", "TASK-2500"]);
      // Identifying a source-ref task does not authorize executing a blob that
      // has no current canonical file. Preserve the existing manual-review state.
      expect(result.tasks[0]).toEqual(
        expect.objectContaining({ sourcePath: changedPath, status: "manual_review" }),
      );
      expect(result.tasks[1]).toEqual(
        expect.objectContaining({ sourcePath: secondPath, status: "manual_review" }),
      );
      expect(logs.join("\n")).toContain(`${malformedPath} (unreadable_or_unparseable_source_blob)`);
      expect(logs.join("\n")).toContain("Priority");
      expect(logs.join("\n")).toContain(
        "TASK-7000-descriptive-second.md (unreadable_or_unparseable_source_blob)",
      );
      expect(fs.readFileSync(path.join(fixture.root, changedPath), "utf8")).toContain(
        "# TASK-9999:",
      );
    });

    it("does not replace an all-malformed branch selection with unrelated current tasks", async () => {
      fixture.git(["switch", "-c", "invalid-source-fixture"]);
      const sourcePath = "docs/tasks/TASK-7777-malformed-only.md";
      fs.writeFileSync(path.join(fixture.root, sourcePath), "# TASK-7777: no metadata\n");
      fixture.git(["add", "."]);
      fixture.git(["commit", "-m", "Malformed source-only task"]);
      fixture.git(["switch", "main"]);
      const logs: string[] = [];
      const result = await runOvernightRunner({
        projectRoot: fixture.root,
        sourceBranch: "invalid-source-fixture",
        targetBranch: "main",
        maxCycles: 0,
        dryRun: true,
        federationDispatch: false,
        logger: (message) => logs.push(message),
      });
      expect(result.tasks).toEqual([]);
      expect(logs.join("\n")).toContain(`${sourcePath} (unreadable_or_unparseable_source_blob)`);
    });
  },
);
