// TASK-1336-B: actual parent/sibling parsing, runtime status resolution,
// canonical mutation and local Git commit. Only the paid SDK response is fake.
import * as fs from "node:fs";
import * as path from "node:path";
import { loadAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import { _setQueryFn, runPostApprovalLifecycle } from "../../src/dispatcher/lifecycle-manager";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { createDeclaredParentFixture } from "../helpers/declared-parent-fixture";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe.each(["forward", "reverse"] as const)("TASK-1336-B parent aggregation (%s)", (order) => {
  let fixture: ReturnType<typeof createDeclaredParentFixture>;
  let emitted: Array<{ stage: string; payload: unknown }>;
  beforeEach(() => {
    fixture = createDeclaredParentFixture(order);
    emitted = [];
  });
  afterEach(() => {
    _setQueryFn(undefined);
    fixture.cleanup();
  });
  async function completeFirst() {
    const task = parseTaskFile(fs.readFileSync(fixture.firstPath, "utf8"), fixture.firstPath);
    const response =
      task.successCriteria
        .map((criterion) => `CRITERION: ${criterion}\nSTATUS: PASS\nEVIDENCE: fixture proof`)
        .join("\n") + "\nOVERALL: PASS";
    _setQueryFn(async function* () {
      yield await Promise.resolve({ type: "result", subtype: "success", result: response });
    });
    const events: IEventWriter = {
      sessionId: "parent-aggregation",
      taskId: task.id,
      project: "fixture",
      emit(stage, payload) {
        emitted.push({ stage, payload });
      },
      recordSession() {},
    };
    return runPostApprovalLifecycle(
      task.id,
      task,
      await loadAdapter(fixture.root),
      fixture.root,
      events,
    );
  }

  it("checks lettered siblings by declared ID and completes their actual parent", async () => {
    fs.unlinkSync(fixture.malformedPath);
    const result = await completeFirst();
    expect(result.verified).toBe(true);
    expect(result.parentCompleted).toBe("TASK-100");
    expect(emitted.find((event) => event.stage === "lifecycle_parent_completed")?.payload).toEqual({
      parentTaskId: "TASK-100",
      subtaskCount: 2,
      subtaskIds: ["TASK-100-A", "TASK-100-B"],
    });
    expect(parseTaskFile(fs.readFileSync(fixture.parentPath, "utf8")).status).toBe("COMPLETE");
  });

  it("holds a malformed claiming child and names its exact path and parse error", async () => {
    const before = fs.readFileSync(fixture.parentPath, "utf8");
    const result = await completeFirst();
    expect(result.parentCompleted).toBeNull();
    expect(fs.readFileSync(fixture.parentPath, "utf8")).toBe(before);
    const errorPayload = emitted.find(
      (event) =>
        event.stage === "session_error" &&
        JSON.stringify(event.payload).includes("lifecycle_parent_completion"),
    )?.payload as { error?: string; failedStage?: string } | undefined;
    expect(errorPayload?.failedStage).toBe("lifecycle_parent_completion");
    expect(errorPayload?.error).toContain(
      `Parent TASK-100 completion held: claiming child ${fixture.malformedPath} cannot be parsed:`,
    );
    expect(errorPayload?.error).toContain("Missing required metadata field: Priority");
    const log = fs.readFileSync(
      path.join(fixture.root, ".quack", "lifecycle-errors.jsonl"),
      "utf8",
    );
    expect(log).toContain("parent_child_parse_error");
    expect(JSON.parse(log.trim())).toMatchObject({
      taskId: "TASK-100",
      specPath: fixture.malformedPath,
    });
    expect(log).toContain("Priority");
    expect(emitted.some((event) => event.stage === "lifecycle_parent_completed")).toBe(false);
  });

  it("ignores prefix-related parent fields, prose mentions and the parent itself", async () => {
    fs.unlinkSync(fixture.malformedPath);
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-6000-prefix.md"),
      taskSpec("TASK-1000-A", { status: "READY" }) + "\nParent Task: TASK-1000\n",
    );
    fs.writeFileSync(
      path.join(fixture.taskDir, "TASK-5000-prose.md"),
      taskSpec("TASK-5000", { status: "READY" }) +
        "\nThis prose mentions Parent Task: TASK-100 as context.\n",
    );
    fs.appendFileSync(fixture.parentPath, "\nParent Task: TASK-100\n");
    const result = await completeFirst();
    expect(result.parentCompleted).toBe("TASK-100");
    expect(emitted.find((event) => event.stage === "lifecycle_parent_completed")?.payload).toEqual(
      expect.objectContaining({ subtaskIds: ["TASK-100-A", "TASK-100-B"] }),
    );
  });

  it("requires a complete parent field on the completing task too", async () => {
    fs.unlinkSync(fixture.malformedPath);
    const content = fs
      .readFileSync(fixture.firstPath, "utf8")
      .replace("Parent Task: TASK-100", "This prose mentions Parent Task: TASK-100");
    fs.writeFileSync(fixture.firstPath, content);
    const result = await completeFirst();
    expect(result.parentCompleted).toBeNull();
    expect(parseTaskFile(fs.readFileSync(fixture.parentPath, "utf8")).status).toBe("IN_PROGRESS");
  });

  it("holds when the actual second declared sibling remains incomplete", async () => {
    fs.unlinkSync(fixture.malformedPath);
    const content = fs
      .readFileSync(fixture.secondPath, "utf8")
      .replace("**Status:** COMPLETE", "**Status:** IN_PROGRESS");
    fs.writeFileSync(fixture.secondPath, content);
    const result = await completeFirst();
    expect(result.parentCompleted).toBeNull();
    expect(parseTaskFile(fs.readFileSync(fixture.parentPath, "utf8")).status).toBe("IN_PROGRESS");
  });

  it.each(["same-parent", "missing-parent"])(
    "holds an ambiguous completed sibling with a %s duplicate declaration",
    async (membership) => {
      fs.unlinkSync(fixture.malformedPath);
      const duplicatePath = path.join(fixture.taskDir, "TASK-6000-duplicate-second.md");
      const original = fs.readFileSync(fixture.secondPath, "utf8");
      const duplicate =
        membership === "same-parent" ? original : original.replace("Parent Task: TASK-100\n", "");
      fs.writeFileSync(duplicatePath, duplicate);
      const parentBefore = fs.readFileSync(fixture.parentPath, "utf8");
      const result = await completeFirst();
      expect(result.verified).toBe(true);
      expect(result.statusUpdated).toBe(true);
      expect(result.parentCompleted).toBeNull();
      expect(fs.readFileSync(fixture.parentPath, "utf8")).toBe(parentBefore);
      expect(fs.readFileSync(fixture.secondPath, "utf8")).toBe(original);
      expect(fs.readFileSync(duplicatePath, "utf8")).toBe(duplicate);
      const errorPayload = emitted.find((event) => event.stage === "session_error")?.payload as
        | { error?: string; failedStage?: string }
        | undefined;
      expect(errorPayload?.failedStage).toBe("lifecycle_parent_completion");
      expect(errorPayload?.error).toContain("TASK-100-B");
      expect(errorPayload?.error).toContain(path.basename(fixture.secondPath));
      expect(errorPayload?.error).toContain(path.basename(duplicatePath));
      const log = JSON.parse(
        fs.readFileSync(path.join(fixture.root, ".quack", "lifecycle-errors.jsonl"), "utf8").trim(),
      ) as { taskId: string; errorType: string; claimants: string[] };
      expect(log).toMatchObject({
        taskId: "TASK-100",
        errorType: "parent_child_identity_conflict",
      });
      expect(log.claimants).toEqual(
        [path.basename(duplicatePath), path.basename(fixture.secondPath)].sort(),
      );
      expect(emitted.some((event) => event.stage === "lifecycle_parent_completed")).toBe(false);
    },
  );
});
