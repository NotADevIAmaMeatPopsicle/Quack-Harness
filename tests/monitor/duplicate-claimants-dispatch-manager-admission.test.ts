// TASK-1338-C pre-change record: the supplied claimant result was ignored,
// startWorktree executed, and the intended duplicate_claimants assertion red.

import * as fs from "node:fs";
import * as path from "node:path";

import { PausedRunRefusalError } from "../../src/dispatcher/paused-run-state";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  removeFixture,
} from "../helpers/duplicate-claimants-fixture";

function job(taskId: string): DispatchJob {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    pid: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    output: [],
  };
}

describe.each(DUPLICATE_FIXTURE_CASES)(
  "DispatchManager.start claimant defence (%s, %s)",
  (kind, order) => {
    it("refuses before an awaiting-approval deletion or worktree operation", () => {
      const fixture = createDuplicateFixture("quack-manager-admission-", kind, order);
      try {
        const manager = new DispatchManager(fixture.root, "fixture-bin.js");
        const startWorktree = jest.fn((taskId: string) => job(taskId));
        (manager as unknown as { startWorktree: typeof startWorktree }).startWorktree =
          startWorktree;
        const jobs = (manager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
        const awaiting = { ...job("TASK-100"), status: "awaiting_approval" as const };
        jobs.set("TASK-100", awaiting);
        expect(() =>
          manager.start(
            "TASK-100",
            { resume: true },
            {
              taskId: "TASK-100",
              claimants: fixture.claimants,
            },
          ),
        ).toThrow(/duplicate claimants/i);

        expect(jobs.get("TASK-100")).toBe(awaiting);
        expect(startWorktree).not.toHaveBeenCalled();
      } finally {
        removeFixture(fixture.root);
      }
    });

    it.each([
      ["running", "Task TASK-100 is already running (pid 1)"],
      [
        "awaiting_approval",
        "Task TASK-100 is awaiting human approval at a gate. Approve or reject via the dashboard, or stop the task first.",
      ],
    ] as const)("keeps the existing %s refusal ahead of claimant admission", (status, expected) => {
      const fixture = createDuplicateFixture("quack-manager-active-noop-", kind, order);
      try {
        const manager = new DispatchManager(fixture.root, "fixture-bin.js");
        const startWorktree = jest.fn((taskId: string) => job(taskId));
        (manager as unknown as { startWorktree: typeof startWorktree }).startWorktree =
          startWorktree;
        const jobs = (manager as unknown as { jobs: Map<string, DispatchJob> }).jobs;
        const existing = { ...job("TASK-100"), status };
        jobs.set("TASK-100", existing);
        jest.spyOn(manager, "getActiveJob").mockReturnValue(existing);

        expect(() =>
          manager.start("TASK-100", undefined, {
            taskId: "TASK-100",
            claimants: fixture.claimants,
          }),
        ).toThrow(expected);
        expect(jobs.get("TASK-100")).toBe(existing);
        expect(startWorktree).not.toHaveBeenCalled();
      } finally {
        removeFixture(fixture.root);
      }
    });

    it("keeps degraded-isolation refusal ahead of claimant admission", () => {
      const fixture = createDuplicateFixture("quack-manager-degraded-noop-", kind, order);
      try {
        const manager = new DispatchManager(fixture.root, "fixture-bin.js");
        const startWorktree = jest.fn((taskId: string) => job(taskId));
        (manager as unknown as { startWorktree: typeof startWorktree }).startWorktree =
          startWorktree;
        (manager as unknown as { worktreeDegraded: boolean }).worktreeDegraded = true;
        jest.spyOn(manager, "getActiveJobs").mockReturnValue([job("TASK-200")]);

        expect(() =>
          manager.start("TASK-100", undefined, {
            taskId: "TASK-100",
            claimants: fixture.claimants,
          }),
        ).toThrow(
          "Worktree isolation is degraded (creation failed). Cannot dispatch TASK-100 while TASK-200 is running in the shared directory. Wait for active tasks to finish, or restart the monitor to retry worktree creation.",
        );
        expect(startWorktree).not.toHaveBeenCalled();
      } finally {
        removeFixture(fixture.root);
      }
    });

    it("keeps the durable paused-run refusal ahead of claimant admission", () => {
      const fixture = createDuplicateFixture("quack-manager-paused-noop-", kind, order);
      const createdAt = new Date().toISOString();
      try {
        const approvalDir = path.join(fixture.root, ".quack", "logs", "approvals");
        fs.mkdirSync(approvalDir, { recursive: true });
        const approvalPath = path.join(approvalDir, "TASK-100-judge.json");
        const approvalBytes = JSON.stringify(
          {
            taskId: "TASK-100",
            state: "pending",
            createdAt,
          },
          null,
          2,
        );
        fs.writeFileSync(approvalPath, approvalBytes);
        const manager = new DispatchManager(fixture.root, "fixture-bin.js");
        const startWorktree = jest.fn((taskId: string) => job(taskId));
        (manager as unknown as { startWorktree: typeof startWorktree }).startWorktree =
          startWorktree;

        let thrown: unknown;
        try {
          manager.start("TASK-100", undefined, {
            taskId: "TASK-100",
            claimants: fixture.claimants,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(PausedRunRefusalError);
        expect((thrown as Error).message).toBe(
          `Task TASK-100 is paused at the judge review gate (opened ${createdAt}). ` +
            "Starting it fresh would discard that run's state, including its committed work. " +
            "Approve or reject the gate, stop the task, or re-send with an explicit override.",
        );
        expect(fs.readFileSync(approvalPath, "utf-8")).toBe(approvalBytes);
        expect(startWorktree).not.toHaveBeenCalled();
      } finally {
        removeFixture(fixture.root);
      }
    });
  },
);
