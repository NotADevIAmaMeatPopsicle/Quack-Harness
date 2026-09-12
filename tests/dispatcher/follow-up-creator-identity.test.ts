// TASK-1345 pre-change proof: both fixtures failed because the writer reused
// TASK-100-FU1; the same-slug case overwrote the legacy file and the
// different-slug case created a second unparseable claimant.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import type { FollowUpItem } from "../../src/core/types";
import { createFollowUpTasks } from "../../src/dispatcher/dispatcher";
import { remoteTaskIntakeSchema } from "../../src/intake/task-intake";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import { taskSpec } from "../helpers/duplicate-claimants-fixture";

function adapter(root: string): ProjectAdapter {
  return {
    projectRoot: root,
    config: { project: { taskDir: "docs/tasks" } },
  } as ProjectAdapter;
}

function eventWriter(events: Array<{ stage: string; payload: unknown }>): IEventWriter {
  return {
    sessionId: "task-1345-follow-up",
    taskId: "TASK-100",
    project: "fixture",
    emit(stage, payload) {
      events.push({ stage, payload });
    },
    recordSession() {},
  };
}

describe.each([
  ["same slug", "TASK-100-FU1-hardening.md"],
  ["different slug", "TASK-100-FU1-legacy-title.md"],
] as const)("TASK-1345 follow-up allocation: %s", (_label, legacyName) => {
  it("preserves legacy FU bytes and mints one globally allocated base id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-follow-up-creator-"));
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const parentPath = path.join(taskDir, "TASK-100-parent.md");
    fs.writeFileSync(parentPath, taskSpec("TASK-100", { title: "Parent" }), "utf-8");
    fs.writeFileSync(
      path.join(taskDir, "TASK-0200-high-water.md"),
      taskSpec("TASK-0200", { title: "High water" }),
      "utf-8",
    );
    const legacyPath = path.join(taskDir, legacyName);
    const legacyBytes = "# TASK-100-FU1: legacy parser-invalid follow-up\nlegacy bytes\n";
    fs.writeFileSync(legacyPath, legacyBytes, "utf-8");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "quack-tests@example.invalid"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Tests"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
    const events: Array<{ stage: string; payload: unknown }> = [];
    const item: FollowUpItem = {
      title: "Hardening",
      description: "Add the missing hardening behavior.",
      type: "optimization",
    };

    try {
      const created = await createFollowUpTasks(
        "TASK-100",
        parseTaskFile(fs.readFileSync(parentPath, "utf-8"), parentPath),
        adapter(root),
        [item],
        eventWriter(events),
      );

      expect(created).toHaveLength(1);
      expect(path.basename(created[0])).toBe("TASK-0201-hardening.md");
      expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyBytes);
      const generated = parseTaskFile(fs.readFileSync(created[0], "utf-8"), created[0]);
      expect(generated.id).toBe("TASK-0201");
      expect(generated.blockedBy).toContain("TASK-100");
      expect(fs.readFileSync(created[0], "utf-8")).toContain("**Parent Task:** TASK-100");
      expect(
        remoteTaskIntakeSchema.safeParse({
          taskId: generated.id,
          title: generated.title,
          description: "Generated follow-up compatibility check",
        }).success,
      ).toBe(true);
      expect(events.find((event) => event.stage === "follow_up_tasks_created")?.payload).toEqual({
        parentTaskId: "TASK-100",
        count: 1,
        taskIds: [generated.id],
      });
      expect(events.some((event) => event.stage === "follow_up_child_creation_refused")).toBe(
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
