// TASK-1336-C: real declared-ID inventory proofs. Four-digit base syntax is
// an already-landed TASK-1345 compatibility control; divergent inventories,
// child/SAURUS dependency grammar and malformed-file exclusion are new proofs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import { buildPlannerPrompt } from "../../src/planner/planner-prompt";
import { createTaskFilesFromInput, writeTaskFilesWithResult } from "../../src/planner/task-writer";
import { taskSpec, writeTestAdapter } from "../helpers/divergent-task-fixture";

describe.each(["forward", "reverse"])("TASK-1336-C planner declarations (%s)", (order) => {
  let root: string;
  let taskDir: string;
  let adapter: ProjectAdapter;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336c-planner-"));
    taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    writeTestAdapter(root);
    adapter = await loadAdapter(root);
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  function write(entries: Array<[string, string]>): void {
    for (const [name, content] of order === "forward" ? entries : [...entries].reverse()) {
      fs.writeFileSync(path.join(taskDir, name), content);
    }
  }

  it("finds a four-digit dependency by declaration under a divergent filename", async () => {
    write([
      ["TASK-001-low-name.md", taskSpec("TASK-1402")],
      ["TASK-9999-high-name.md", taskSpec("TASK-001")],
    ]);
    const content = taskSpec("TASK-1500").replace(
      "**Blocked By:** []",
      "**Blocked By:** [TASK-1402]",
    );
    const result = await writeTaskFilesWithResult([{ id: "TASK-1500", content }], adapter);
    expect(result.taskIds).toEqual(["TASK-1500"]);
    expect(parseTaskFile(fs.readFileSync(result.filePaths[0], "utf8")).blockedBy).toEqual([
      "TASK-1402",
    ]);
  });

  it("uses declared numbers rather than either filename extreme for the planner prompt", async () => {
    write([
      ["TASK-001-low-name.md", taskSpec("TASK-1402")],
      ["TASK-9999-high-name.md", taskSpec("TASK-001")],
      ["TASK-99999-malformed.md", "# TASK-88888: missing metadata\n"],
      ["TASK-77777-no-heading.md", "not a task\n"],
    ]);
    const prompt = await buildPlannerPrompt("Plan the next bounded change", adapter);
    expect(prompt).toContain("Start numbering from TASK-1403:");
    expect(prompt).not.toContain("Start numbering from TASK-100000:");
  });

  it("does not treat a malformed or absent dependency filename as an allocated ID", async () => {
    write([["TASK-1402-pretender.md", "# TASK-1402: incomplete\n"]]);
    for (const dependency of ["TASK-1402", "TASK-1499"]) {
      const content = taskSpec("TASK-1500").replace(
        "**Blocked By:** []",
        `**Blocked By:** [${dependency}]`,
      );
      await expect(
        writeTaskFilesWithResult([{ id: "TASK-1500", content }], adapter),
      ).rejects.toThrow(`Dependency ${dependency} references non-existent task ID`);
    }
    expect(fs.readdirSync(taskDir)).toEqual(["TASK-1402-pretender.md"]);
  });

  it("uses parser grammar for lettered and SAURUS dependencies", async () => {
    write([
      ["TASK-001-first.md", taskSpec("TASK-1402-A")],
      ["TASK-002-second.md", taskSpec("SAURUS-REM-001")],
    ]);
    const content = taskSpec("TASK-1500-B").replace(
      "**Blocked By:** []",
      "**Blocked By:** [TASK-1402-A, SAURUS-REM-001]",
    );
    const result = await writeTaskFilesWithResult([{ id: "TASK-1500-B", content }], adapter);
    expect(result.taskIds).toEqual(["TASK-1500-B"]);
  });

  it("retains the already-supported four-digit generated-input syntax", async () => {
    const result = await createTaskFilesFromInput(
      [
        {
          id: "TASK-1402",
          title: "Four digit input",
          priority: "P2-MEDIUM",
          effort: "1 hour",
          status: "READY",
          problemStatement:
            "Exercise canonical four digit generated input without a filename alias.",
          successCriteria: ["The generated file declares TASK-1402."],
          testingRequirements: ["Parse the file that was created."],
        },
      ],
      adapter,
    );
    expect(parseTaskFile(fs.readFileSync(result.filePaths[0], "utf8")).id).toBe("TASK-1402");
  });
});
