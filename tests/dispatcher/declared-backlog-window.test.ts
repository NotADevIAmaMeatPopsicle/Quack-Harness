// TASK-1336-C: both production consumers read a >30-file inverse-order corpus.
// Legacy parser-invalid FU preservation is covered by follow-up-creator-identity;
// the direct parse assertions below retain the accepted TASK-1345 grammar decision.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import { createFollowUpTasks } from "../../src/dispatcher/dispatcher";
import { loadBacklogEntries, loadRecentBacklogSummary } from "../../src/dispatcher/follow-up-dedup";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { taskSpec, writeTestAdapter } from "../helpers/divergent-task-fixture";

describe.each(["forward", "reverse"])("TASK-1336-C declared backlog window (%s)", (order) => {
  let root: string;
  let taskDir: string;
  let adapter: ProjectAdapter;
  let parentPath: string;
  let selectedPath: string;
  let excludedPath: string;
  const selectedTitle = "Recover authoritative issue publication after response loss";
  const excludedTitle = "Document color swatches for a static component gallery";
  const selectedIds = Array.from({ length: 30 }, (_, index) => `TASK-${1400 - index}`);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336c-window-"));
    taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    writeTestAdapter(root);
    adapter = await loadAdapter(root);
    const entries: Array<[string, string]> = [];
    for (let index = 0; index < 40; index++) {
      const id = `TASK-${1400 - index}`;
      const file = `TASK-${String(index + 1).padStart(4, "0")}-inverse.md`;
      const title =
        index === 0
          ? selectedTitle
          : index === 39
            ? excludedTitle
            : `Existing inventory item ${index}`;
      entries.push([file, taskSpec(id, { title, status: "BACKLOG" })]);
      if (index === 0) selectedPath = path.join(taskDir, file);
      if (index === 39) excludedPath = path.join(taskDir, file);
    }
    entries.push(["TASK-99999-malformed.md", "# TASK-99999: malformed\n"]);
    entries.push(["TASK-99998-complete.md", taskSpec("TASK-99998", { status: "COMPLETE" })]);
    entries.push(["TASK-0500-parent.md", taskSpec("TASK-0500", { status: "IN_PROGRESS" })]);
    for (const [name, content] of order === "forward" ? entries : [...entries].reverse())
      fs.writeFileSync(path.join(taskDir, name), content);
    parentPath = path.join(taskDir, "TASK-0500-parent.md");
    for (const args of [
      ["init"],
      ["config", "user.name", "Quack Fixture"],
      ["config", "user.email", "quack@example.invalid"],
      ["add", "."],
      ["commit", "-m", "bounded fixture"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    }
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );

  it("parses before trimming and gives the judge the exact declaration-ordered window", async () => {
    const entries = await loadBacklogEntries(taskDir);
    expect(entries.map((entry) => entry.taskId)).toEqual(selectedIds);
    expect(entries[0].filePath).toBe(selectedPath);
    const summary = await loadRecentBacklogSummary(taskDir);
    expect(summary?.split("\n").map((line) => line.match(/^- (TASK-\d+):/)?.[1])).toEqual(
      selectedIds,
    );
    expect(summary).toContain(selectedTitle);
    expect(summary).not.toContain(excludedTitle);
  });

  it("dedups against the selected declaration and emits a canonical ID for the excluded one", async () => {
    const selectedBefore = fs.readFileSync(selectedPath, "utf8");
    const excludedBefore = fs.readFileSync(excludedPath, "utf8");
    const events: Array<{ stage: string; payload: unknown }> = [];
    const writer: IEventWriter = {
      sessionId: "declared-window",
      taskId: "TASK-0500",
      project: "fixture",
      emit(stage, payload) {
        events.push({ stage, payload });
      },
      recordSession() {},
    };
    const created = await createFollowUpTasks(
      "TASK-0500",
      parseTaskFile(fs.readFileSync(parentPath, "utf8")),
      adapter,
      [
        {
          title: selectedTitle,
          description: "Recover the publication correctly.",
          type: "optimization",
        },
        {
          title: excludedTitle,
          description: "Document the available color swatches.",
          type: "optimization",
        },
      ],
      writer,
    );
    expect(created).toHaveLength(1);
    expect(fs.readFileSync(selectedPath, "utf8")).toBe(
      selectedBefore.trimEnd() + "\n<!-- Also flagged by judge run for TASK-0500 -->\n",
    );
    expect(fs.readFileSync(excludedPath, "utf8")).toBe(excludedBefore);
    const generated = parseTaskFile(fs.readFileSync(created[0], "utf8"));
    // COMPLETE files are excluded from the window, but remain allocated IDs.
    expect(generated.id).toBe("TASK-99999");
    expect(generated.title).toContain(excludedTitle);
    expect(events.find((event) => event.stage === "follow_up_tasks_created")?.payload).toEqual({
      parentTaskId: "TASK-0500",
      count: 1,
      taskIds: [generated.id],
    });
    expect(path.basename(created[0], ".md")).not.toBe(generated.id);
  });
});
