import {
  assertSafeGitRef,
  shouldReconcileFederatedJob,
} from "../../src/monitor/federation/orchestration.js";
import type { FederatedJobRecord } from "../../src/monitor/federation/types.js";

function makeJob(overrides: Partial<FederatedJobRecord> = {}): FederatedJobRecord {
  return {
    jobId: "fed-task-001-test",
    taskId: "TASK-001",
    jobType: "dispatch",
    status: "queued",
    correlationId: "corr-task-001",
    requiredCapabilities: ["dispatch"],
    decision: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("federation orchestration helpers", () => {
  test("shouldReconcileFederatedJob returns true for merge-ready review follow-up states", () => {
    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "blocked",
          blockReasonCode: "review_linkage_required",
        }),
      ),
    ).toBe(true);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "completed",
          nextAction: "record_merge_ready_review",
        }),
      ),
    ).toBe(true);
  });

  test("shouldReconcileFederatedJob ignores terminal failure states and unrelated blocked jobs", () => {
    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "failed",
          error: "verification_failed",
        }),
      ),
    ).toBe(false);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "blocked",
          blockReasonCode: "pending_manual_handoff",
          error: "task_not_found",
        }),
      ),
    ).toBe(false);
  });

  test("assertSafeGitRef accepts normal refs and rejects dangerous values", () => {
    expect(() => assertSafeGitRef("origin/quack/TASK-884-B", "branchName")).not.toThrow();
    expect(() => assertSafeGitRef("dev", "targetBranch")).not.toThrow();

    expect(() => assertSafeGitRef("../evil", "branchName")).toThrow(
      "branchName contains unsafe characters.",
    );
    expect(() => assertSafeGitRef("-main", "targetBranch")).toThrow(
      "targetBranch contains unsafe characters.",
    );
  });
});
