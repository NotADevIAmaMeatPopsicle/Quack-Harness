// TASK-1338-B pre-change record: the first run was PROVISIONAL because the
// private helper was not exported and no assertion executed. After the
// smallest export-only scaffold, all four behavioural arms executed and
// FAILED at the intended [] assertion after appending and creating a FU file.
// The all-suppressed and idempotent batches are CONTROL arms. The direct
// multi-intent query-count oracle executed and FAILED with zero calls.

import * as fs from "node:fs";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import * as taskFileResolver from "../../src/core/task-file-resolver";
import { parseTaskFile } from "../../src/core/task-parser";
import type { FollowUpItem } from "../../src/core/types";
import { createFollowUpTasks } from "../../src/dispatcher/dispatcher";
import type { IEventWriter } from "../../src/monitor/event-emitter";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  removeFixture,
  taskSpec,
} from "../helpers/duplicate-claimants-fixture";

function adapter(root: string): ProjectAdapter {
  return {
    projectRoot: root,
    config: { project: { taskDir: "docs/tasks" } },
  } as ProjectAdapter;
}

function writer(events: Array<{ stage: string; payload: unknown }>): IEventWriter {
  return {
    sessionId: "follow-up-test",
    taskId: "TASK-100",
    project: "fixture",
    emit(stage, payload) {
      events.push({ stage, payload });
    },
    recordSession() {},
  };
}

function items(): FollowUpItem[] {
  return [
    {
      title: "Existing hardening work",
      description: "Append a linked-from marker to the existing task.",
      type: "optimization",
      estimatedEffort: "1-2 hours",
    },
    {
      title: "Unique follow up work",
      description: "Create a new follow-up task spec.",
      type: "optimization",
      estimatedEffort: "1-2 hours",
    },
  ];
}

function writeExistingBacklog(taskDir: string, marker = false): string {
  const filePath = path.join(taskDir, "TASK-200-existing-hardening.md");
  const content = `${taskSpec("TASK-200", {
    status: "BACKLOG",
    title: "Existing hardening work",
  })}${marker ? "\n<!-- Also flagged by judge run for TASK-100 -->\n" : ""}`;
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "judge follow-up duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("refuses the whole batch before the first append or FU write", async () => {
      const fixture = createDuplicateFixture("quack-follow-up-veto-", kind, order);
      const existingPath = writeExistingBacklog(fixture.taskDir);
      const existingBefore = fs.readFileSync(existingPath, "utf-8");
      const parent = parseTaskFile(
        fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
        fixture.claimantPaths[0],
      );
      const events: Array<{ stage: string; payload: unknown }> = [];
      try {
        const created = await createFollowUpTasks(
          "TASK-100",
          parent,
          adapter(fixture.root),
          items(),
          writer(events),
        );
        expect(created).toEqual([]);
        expectClaimantsUnchanged(fixture);
        expect(fs.readFileSync(existingPath, "utf-8")).toBe(existingBefore);
        expect(fs.readdirSync(fixture.taskDir).filter((name) => name.includes("-FU"))).toEqual([]);
        expect(events).toEqual([
          {
            stage: "follow_up_tasks_refused",
            payload: {
              parentTaskId: "TASK-100",
              errorType: "duplicate_claimants",
              claimants: fixture.claimants,
            },
          },
        ]);
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

it("single claimant passes through both append and create arms", async () => {
  const fixture = createSingleClaimantFixture("quack-follow-up-single-");
  const existingPath = writeExistingBacklog(fixture.taskDir);
  const parent = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  const events: Array<{ stage: string; payload: unknown }> = [];
  try {
    const created = await createFollowUpTasks(
      "TASK-100",
      parent,
      adapter(fixture.root),
      items(),
      writer(events),
    );
    expect(created).toHaveLength(1);
    expect(fs.readFileSync(existingPath, "utf-8")).toContain(
      "<!-- Also flagged by judge run for TASK-100 -->",
    );
    expect(fs.existsSync(created[0])).toBe(true);
  } finally {
    removeFixture(fixture.root);
  }
});

it("all ignored items on a contested parent perform zero claimant queries and emit no refusal", async () => {
  const fixture = createDuplicateFixture("quack-follow-up-ignored-", "cross-population", "forward");
  fs.mkdirSync(path.join(fixture.root, ".quack"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.root, ".quack", "follow-up-ignored.json"),
    JSON.stringify(["ignored suggestion"]),
    "utf-8",
  );
  const parent = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  const events: Array<{ stage: string; payload: unknown }> = [];
  const querySpy = jest.spyOn(taskFileResolver, "listDuplicateClaimants");
  try {
    const created = await createFollowUpTasks(
      "TASK-100",
      parent,
      adapter(fixture.root),
      [{ title: "ignored suggestion", description: "ignored", type: "optimization" }],
      writer(events),
    );
    expect(created).toEqual([]);
    expect(querySpy).toHaveBeenCalledTimes(0);
    expect(events.filter((event) => event.stage === "follow_up_tasks_refused")).toHaveLength(0);
    expectClaimantsUnchanged(fixture);
  } finally {
    querySpy.mockRestore();
    removeFixture(fixture.root);
  }
});

it("all idempotent appends on a contested parent perform zero claimant queries", async () => {
  const fixture = createDuplicateFixture(
    "quack-follow-up-idempotent-",
    "cross-population",
    "forward",
  );
  const existingPath = writeExistingBacklog(fixture.taskDir, true);
  const existingBefore = fs.readFileSync(existingPath, "utf-8");
  const parent = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  const events: Array<{ stage: string; payload: unknown }> = [];
  const querySpy = jest.spyOn(taskFileResolver, "listDuplicateClaimants");
  try {
    expect(
      await createFollowUpTasks(
        "TASK-100",
        parent,
        adapter(fixture.root),
        [items()[0]],
        writer(events),
      ),
    ).toEqual([]);
    expect(querySpy).toHaveBeenCalledTimes(0);
    expect(fs.readFileSync(existingPath, "utf-8")).toBe(existingBefore);
    expect(events.filter((event) => event.stage === "follow_up_tasks_refused")).toHaveLength(0);
  } finally {
    querySpy.mockRestore();
    removeFixture(fixture.root);
  }
});

it("a single-claimant batch reaching append and create mutation intents queries exactly once", async () => {
  const fixture = createSingleClaimantFixture("quack-follow-up-memo-");
  const existingPath = writeExistingBacklog(fixture.taskDir);
  const parent = parseTaskFile(
    fs.readFileSync(fixture.claimantPaths[0], "utf-8"),
    fixture.claimantPaths[0],
  );
  const querySpy = jest.spyOn(taskFileResolver, "listDuplicateClaimants");
  try {
    const created = await createFollowUpTasks(
      "TASK-100",
      parent,
      adapter(fixture.root),
      items(),
      writer([]),
    );
    expect(fs.readFileSync(existingPath, "utf-8")).toContain(
      "<!-- Also flagged by judge run for TASK-100 -->",
    );
    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0])).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(1);
  } finally {
    querySpy.mockRestore();
    removeFixture(fixture.root);
  }
});
