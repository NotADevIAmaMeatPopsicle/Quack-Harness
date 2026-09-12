// TASK-1338-B pre-change record: all four writer executions returned true and
// FAILED at the intended false assertion after changing one claimant. The
// missing-status case is a CONTROL for the earlier no-write return.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { updateTaskStatus } from "../../src/dispatcher/lifecycle-manager";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectClaimantsUnchanged,
  removeFixture,
  taskSpec,
} from "../helpers/duplicate-claimants-fixture";

describe.each(DUPLICATE_FIXTURE_CASES)(
  "lifecycle duplicate claimant veto (%s, %s)",
  (kind, order) => {
    it("logs duplicate_claimants and refuses the status write", async () => {
      const fixture = createDuplicateFixture("quack-lifecycle-veto-", kind, order);
      try {
        const updated = await updateTaskStatus("TASK-100", fixture.taskDir, "COMPLETE");
        expect(updated).toBe(false);
        expectClaimantsUnchanged(fixture);

        const logPath = path.join(fixture.root, ".quack", "lifecycle-errors.jsonl");
        const entries = fs
          .readFileSync(logPath, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          taskId: "TASK-100",
          errorType: "duplicate_claimants",
          claimants: fixture.claimants,
        });
        expect(String(entries[0].message)).toContain("TASK-100");
        for (const claimant of fixture.claimants)
          expect(String(entries[0].message)).toContain(claimant);
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);

it("updates normally with one claimant", async () => {
  const fixture = createSingleClaimantFixture("quack-lifecycle-single-");
  try {
    expect(await updateTaskStatus("TASK-100", fixture.taskDir, "COMPLETE")).toBe(true);
    expect(fs.readFileSync(fixture.claimantPaths[0], "utf-8")).toContain("**Status:** COMPLETE");
  } finally {
    removeFixture(fixture.root);
  }
});

it("refuses declared duplicate owners before considering a malformed filename fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-lifecycle-noop-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
  const rawCandidate = path.join(taskDir, "TASK-100-statusless-fixture.md");
  const firstClaimant = path.join(taskDir, "TASK-998-b.md");
  const secondClaimant = path.join(taskDir, "TASK-999-c.md");
  fs.writeFileSync(
    rawCandidate,
    taskSpec("TASK-100").replace("- **Status:** READY", "- Status omitted"),
    "utf-8",
  );
  fs.writeFileSync(firstClaimant, taskSpec("TASK-100"), "utf-8");
  fs.writeFileSync(secondClaimant, taskSpec("TASK-100"), "utf-8");
  const before = new Map(
    [rawCandidate, firstClaimant, secondClaimant].map((filePath) => [
      filePath,
      fs.readFileSync(filePath, "utf-8"),
    ]),
  );
  try {
    expect(await updateTaskStatus("TASK-100", taskDir, "COMPLETE")).toBe(false);
    for (const [filePath, content] of before) {
      expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
    }
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "lifecycle-errors.jsonl"), "utf-8"),
    ) as Record<string, unknown>;
    expect(entry.errorType).toBe("duplicate_claimants");
    expect(entry.claimants).toEqual([path.basename(firstClaimant), path.basename(secondClaimant)]);
  } finally {
    removeFixture(root);
  }
});

it("retains the status-pattern refusal for a malformed raw candidate with no declared owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-lifecycle-raw-noop-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
  const rawCandidate = path.join(taskDir, "TASK-100-statusless-fixture.md");
  const content = taskSpec("TASK-100").replace("- **Status:** READY", "- Status omitted");
  fs.writeFileSync(rawCandidate, content, "utf-8");
  try {
    expect(await updateTaskStatus("TASK-100", taskDir, "COMPLETE")).toBe(false);
    expect(fs.readFileSync(rawCandidate, "utf-8")).toBe(content);
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "lifecycle-errors.jsonl"), "utf-8"),
    ) as Record<string, unknown>;
    expect(entry.errorType).toBe("status_pattern_not_found");
  } finally {
    removeFixture(root);
  }
});
