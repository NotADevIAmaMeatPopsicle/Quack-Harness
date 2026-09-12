// Actual declared inventory, dependency status reads, canonical mutations and
// local Git commits. Only the paid verification response is substituted.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { loadAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import * as taskFileResolver from "../../src/core/task-file-resolver";
import { _setQueryFn, runPostApprovalLifecycle } from "../../src/dispatcher/lifecycle-manager";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { taskSpec, writeTestAdapter } from "../helpers/divergent-task-fixture";

describe("TASK-1336-B blocker declaration authority", () => {
  let root: string;
  let taskDir: string;
  let emitted: Array<{ stage: string; payload: unknown }>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-declared-blockers-"));
    taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    writeTestAdapter(root);
    emitted = [];
  });

  afterEach(() => {
    _setQueryFn(undefined);
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  function prepare(firstName: string, secondName: string, firstStatus: string) {
    const secondStatus = firstStatus === "COMPLETE" ? "BACKLOG" : "COMPLETE";
    const entries: Array<[string, string]> = [
      [firstName, taskSpec("TASK-100", { status: firstStatus })],
      [secondName, taskSpec("TASK-100", { status: secondStatus })],
      [
        "TASK-200-dependent.md",
        taskSpec("TASK-200", { status: "BACKLOG" }).replace(
          "**Blocked By:** []",
          "**Blocked By:** [TASK-100, TASK-300]",
        ),
      ],
      [
        "TASK-300-trigger.md",
        taskSpec("TASK-300").replace("**Blocks:** []", "**Blocks:** [TASK-200, TASK-400]"),
      ],
      [
        "TASK-400-independent.md",
        taskSpec("TASK-400", { status: "BACKLOG" }).replace(
          "**Blocked By:** []",
          "**Blocked By:** [TASK-300]",
        ),
      ],
    ];
    for (const [name, content] of entries) fs.writeFileSync(path.join(taskDir, name), content);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: "pipe",
        windowsHide: true,
      });
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Quack Fixture"]);
    git(["config", "user.email", "quack@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-m", "Declared blocker fixture"]);
    return entries;
  }

  async function completeTrigger(onCompleted?: () => void) {
    const filePath = path.join(taskDir, "TASK-300-trigger.md");
    const task = parseTaskFile(fs.readFileSync(filePath, "utf8"), filePath);
    const response =
      task.successCriteria
        .map((criterion) => `CRITERION: ${criterion}\nSTATUS: PASS\nEVIDENCE: fixture proof`)
        .join("\n") + "\nOVERALL: PASS";
    _setQueryFn(async function* () {
      yield await Promise.resolve({ type: "result", subtype: "success", result: response });
    });
    const events: IEventWriter = {
      sessionId: "blocker-attribution",
      taskId: task.id,
      project: "fixture",
      emit(stage, payload) {
        emitted.push({ stage, payload });
        if (stage === "lifecycle_status_updated") onCompleted?.();
      },
      recordSession() {},
    };
    return runPostApprovalLifecycle(task.id, task, await loadAdapter(root), root, events);
  }

  it.each([
    ["divergent", "TASK-998-first.md", "TASK-999-second.md", "COMPLETE"],
    ["divergent", "TASK-998-first.md", "TASK-999-second.md", "BACKLOG"],
    ["candidate-scoped", "TASK-100-first.md", "TASK-100-second.md", "COMPLETE"],
    ["candidate-scoped", "TASK-100-first.md", "TASK-100-second.md", "BACKLOG"],
  ])(
    "holds %s duplicate blocker %s/%s with first status %s while promoting an independent task",
    async (_layout, firstName, secondName, firstStatus) => {
      const entries = prepare(firstName, secondName, firstStatus);
      const result = await completeTrigger();
      expect(result.verified).toBe(true);
      expect(result.statusUpdated).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.blockersResolved).toEqual(["TASK-400"]);
      for (const [name, before] of entries.slice(0, 3))
        expect(fs.readFileSync(path.join(taskDir, name), "utf8")).toBe(before);
      expect(
        parseTaskFile(fs.readFileSync(path.join(taskDir, "TASK-400-independent.md"), "utf8"))
          .status,
      ).toBe("READY");
      expect(
        emitted
          .filter((event) => event.stage === "lifecycle_blocker_resolved")
          .map((event) => event.payload),
      ).toEqual([{ taskId: "TASK-400", promotedFrom: "BACKLOG", promotedTo: "READY" }]);
      const errorPayload = emitted.find((event) => event.stage === "session_error")?.payload as
        | { error?: string; failedStage?: string }
        | undefined;
      expect(errorPayload?.failedStage).toBe("lifecycle_blocker_resolution");
      expect(errorPayload?.error).toContain("TASK-200");
      expect(errorPayload?.error).toContain("TASK-100");
      expect(errorPayload?.error).toContain(firstName);
      expect(errorPayload?.error).toContain(secondName);
      const log = JSON.parse(
        fs.readFileSync(path.join(root, ".quack", "lifecycle-errors.jsonl"), "utf8").trim(),
      ) as { taskId: string; errorType: string; claimants: string[] };
      expect(log).toMatchObject({
        taskId: "TASK-200",
        errorType: "blocker_identity_conflict",
        claimants: [firstName, secondName].sort(),
      });
    },
  );

  it("holds all promotions when the declared inventory scan fails", async () => {
    const entries = prepare("TASK-998-first.md", "TASK-999-second.md", "COMPLETE");
    const result = await completeTrigger(() => {
      // A single injected read failure after the real trigger status write;
      // all filesystem, identity and mutation behavior otherwise stays real.
      jest
        .spyOn(taskFileResolver, "listTaskClaimantDeclarations")
        .mockRejectedValueOnce(new Error("injected claimant directory unavailable"));
    });
    expect(result.statusUpdated).toBe(true);
    expect(result.blockersResolved).toEqual([]);
    for (const [name, before] of entries.filter(([name]) => name !== "TASK-300-trigger.md"))
      expect(fs.readFileSync(path.join(taskDir, name), "utf8")).toBe(before);
    const errors = emitted.filter((event) => event.stage === "session_error");
    expect(errors).toHaveLength(2);
    for (const event of errors) {
      const payload = event.payload as { error: string; failedStage: string };
      expect(payload.failedStage).toBe("lifecycle_blocker_resolution");
      expect(payload.error).toContain("injected claimant directory unavailable");
      expect(payload.error).toContain("Refusing admission until the scan succeeds");
    }
    expect(emitted.some((event) => event.stage === "lifecycle_blocker_resolved")).toBe(false);
  });
});
