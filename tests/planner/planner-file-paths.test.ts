// TASK-1339-A R5: planner paths are threaded from writes.
//
// The writeTaskFiles contract test is a MATCHER-ONLY CONTROL. It passes on
// the pre-change code because preserving Promise<string[]> is an explicit
// compatibility pin, not a defect to reproduce.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter, type ProjectAdapter } from "../../src/core/adapter-loader";
import { planTasks, _setQueryFn } from "../../src/planner/planner-agent";
import {
  createTaskFilesFromInput,
  writeTaskFiles,
  type TaskSpec,
} from "../../src/planner/task-writer";
import {
  taskSpec,
  writeTestAdapter,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture";

const writeTaskFilesContract: (specs: TaskSpec[], adapter: ProjectAdapter) => Promise<string[]> =
  writeTaskFiles;

function queryFor(
  specs: string[],
): AsyncGenerator<{ type: string; subtype?: string; result?: string }, void> {
  return (async function* () {
    yield await Promise.resolve({
      type: "result",
      subtype: "success",
      result: specs.map((spec) => `\`\`\`markdown\n${spec}\n\`\`\``).join("\n\n"),
    });
  })();
}

describe("TASK-1339-A: PlannerResult.filePaths", () => {
  let root: string;
  let adapter: ProjectAdapter;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-planner-paths-"));
    writeTestAdapter(root);
    adapter = await loadAdapter(root);
  });

  afterEach(() => {
    _setQueryFn(undefined);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("MATCHER-ONLY CONTROL: writeTaskFiles retains Promise<string[]>", () => {
    expect(writeTaskFilesContract).toBe(writeTaskFiles);
  });

  it("returns absolute multi-task paths aligned one-for-one with taskIds", async () => {
    _setQueryFn((() =>
      queryFor([
        taskSpec("TASK-101", { title: "First Planned Task" }),
        taskSpec("TASK-102", { title: "Second Planned Task" }),
      ])) as never);

    const result = await planTasks("Create two tasks", adapter, { maxTasks: 2 });
    const filePaths = (result as unknown as { filePaths?: string[] }).filePaths;
    expect(result.taskIds).toEqual(["TASK-101", "TASK-102"]);
    expect(filePaths).toEqual([
      path.join(root, "docs", "tasks", "TASK-101-first-planned-task.md"),
      path.join(root, "docs", "tasks", "TASK-102-second-planned-task.md"),
    ]);
    expect(filePaths?.every((filePath) => path.isAbsolute(filePath))).toBe(true);
    expect(filePaths?.map((filePath) => fs.readFileSync(filePath, "utf-8").split("\n")[0])).toEqual(
      ["# TASK-101: First Planned Task", "# TASK-102: Second Planned Task"],
    );
  });

  it("returns an empty filePaths array on dry-run", async () => {
    _setQueryFn((() => queryFor([taskSpec("TASK-103", { title: "Dry Run Task" })])) as never);

    const result = await planTasks("Dry run", adapter, { dryRun: true });
    expect((result as unknown as { filePaths?: string[] }).filePaths).toEqual([]);
    expect(fs.existsSync(path.join(root, "docs", "tasks"))).toBe(false);
  });
});

describe.each<FixtureCreationOrder>(["child-first", "parent-first"])(
  "TASK-1339-A: structured writer threads exact paths (%s)",
  (order) => {
    let root: string;
    let adapter: ProjectAdapter;

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-structured-paths-"));
      writeTestAdapter(root);
      adapter = await loadAdapter(root);
      const taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, "TASK-999-sentinel.md"), "sentinel bytes\n", "utf-8");
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it("returns the exact written path for each id without re-resolving", async () => {
      const parent = {
        id: "TASK-140",
        title: "Parent Plan",
        priority: "P2-MEDIUM",
        effort: "1 hour",
        status: "READY",
        problemStatement: "Parent plan",
        successCriteria: ["Parent path is exact"],
        testingRequirements: ["Writer test passes"],
      };
      const child = {
        ...parent,
        id: "TASK-140-A",
        title: "Child Plan",
        problemStatement: "Child plan",
        successCriteria: ["Child path is exact"],
      };
      const inputs = order === "child-first" ? [child, parent] : [parent, child];

      const result = await createTaskFilesFromInput(inputs, adapter);
      const expectedById: Record<string, string> = {
        "TASK-140": path.join(root, "docs", "tasks", "TASK-140-parent-plan.md"),
        "TASK-140-A": path.join(root, "docs", "tasks", "TASK-140-A-child-plan.md"),
      };
      expect(result.filePaths).toEqual(result.taskIds.map((taskId) => expectedById[taskId]));
      expect(result.filePaths.every((filePath) => path.isAbsolute(filePath))).toBe(true);
      expect(
        fs.readFileSync(path.join(root, "docs", "tasks", "TASK-999-sentinel.md"), "utf-8"),
      ).toBe("sentinel bytes\n");
    });

    it("preserves a structured subtask title in its filename", async () => {
      const result = await createTaskFilesFromInput(
        [
          {
            id: "TASK-141-A",
            title: "Named Child",
            priority: "P2-MEDIUM",
            effort: "1 hour",
            status: "READY",
            problemStatement: "Child title should become the slug",
            successCriteria: ["Child filename carries its title"],
            testingRequirements: ["Writer test passes"],
          },
        ],
        adapter,
      );

      expect(result.filePaths[0]).toBe(
        path.join(root, "docs", "tasks", "TASK-141-A-named-child.md"),
      );
    });
  },
);
