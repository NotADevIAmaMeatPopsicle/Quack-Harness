import { recordLoopFinalization } from "../../src/monitor/loop-finalize";
import type { DuplicateClaimantIndex } from "../../src/core/duplicate-claimants";
import type { SessionCompletePayload } from "../../src/monitor/event-types";
import type { VerificationStoreProject } from "../../src/monitor/verification-store";

const project = { projectRoot: "C:\\project" } as VerificationStoreProject;
const eligible: SessionCompletePayload = {
  outcome: "approved",
  durationMs: 10,
  totalCostUsd: 1,
  executionMode: "loop",
  recordOnFinalize: true,
  lifecycleVerified: true,
  autoMerged: true,
  mergeCommitSha: "abc123",
};

describe("recordLoopFinalization", () => {
  test("records one guarded SOFT-VERIFIED row for an eligible canonical result", async () => {
    const recorder = jest.fn().mockResolvedValue({
      applied: true,
      row: { task_id: "TASK-1307" },
    });
    const result = await recordLoopFinalization("canonical", "TASK-1307", eligible, {
      project,
      getCriteriaCount: () => Promise.resolve(4),
      recorder,
    });

    expect(result).toMatchObject({ attempted: true, commit: "abc123" });
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        taskId: "TASK-1307",
        verdict: "SOFT-VERIFIED",
        method: "loop-finalize",
        commitSha: "abc123",
        criteriaChecked: 4,
        criteriaPassed: 4,
      }),
      { skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"] },
    );
  });

  test.each([
    ["cache", eligible, "non-canonical-authority"],
    ["canonical", { ...eligible, executionMode: "dispatch" }, "not-loop"],
    ["canonical", { ...eligible, recordOnFinalize: false }, "recording-disabled"],
    ["canonical", { ...eligible, lifecycleVerified: false }, "lifecycle-not-verified"],
    ["canonical", { ...eligible, autoMerged: false }, "not-auto-merged"],
    ["canonical", { ...eligible, mergeCommitSha: undefined }, "missing-merge-sha"],
  ] as const)("does not write for %s / %s", async (authority, payload, reason) => {
    const recorder = jest.fn();
    const getCriteriaCount = jest.fn();
    const result = await recordLoopFinalization(authority, "TASK-1307", payload, {
      project,
      getCriteriaCount,
      recorder,
    });

    expect(result).toEqual({ attempted: false, reason });
    expect(recorder).not.toHaveBeenCalled();
    expect(getCriteriaCount).not.toHaveBeenCalled();
  });

  test("does not write when the canonical monitor has no bound project root", async () => {
    const recorder = jest.fn();
    const getCriteriaCount = jest.fn();
    const result = await recordLoopFinalization("canonical", "TASK-1307", eligible, {
      project: {} as VerificationStoreProject,
      getCriteriaCount,
      recorder,
    });

    expect(result).toEqual({ attempted: false, reason: "missing-project-root" });
    expect(recorder).not.toHaveBeenCalled();
    expect(getCriteriaCount).not.toHaveBeenCalled();
  });

  test("surfaces an existing protected row as an unapplied guarded record", async () => {
    const recorder = jest.fn().mockResolvedValue({
      applied: false,
      skippedReason: "existing-verdict",
      row: { task_id: "TASK-1307", verdict: "VERIFIED" },
    });
    const result = await recordLoopFinalization("canonical", "TASK-1307", eligible, {
      project,
      getCriteriaCount: () => Promise.resolve(4),
      recorder,
    });

    expect(result).toMatchObject({
      attempted: true,
      record: { applied: false, skippedReason: "existing-verdict" },
    });
  });

  test("passes the prebuilt strict index to the positive loop-finalization writer", async () => {
    const claimantIndex: DuplicateClaimantIndex = {
      status: "scanned",
      contested: new Map([["TASK-1307", ["TASK-1307-a.md", "TASK-999-b.md"]]]),
    };
    const recorder = jest.fn().mockResolvedValue({
      applied: false,
      skippedReason: "duplicate-claimants",
      refusal: {
        error: "duplicate_claimants",
        taskId: "TASK-1307",
        claimants: ["TASK-1307-a.md", "TASK-999-b.md"],
        message: "refused",
      },
      row: { task_id: "TASK-1307", verdict: "SOFT-VERIFIED" },
    });

    const result = await recordLoopFinalization("canonical", "TASK-1307", eligible, {
      project,
      getCriteriaCount: () => Promise.resolve(4),
      recorder,
      claimantIndex,
    });

    expect(result).toMatchObject({
      attempted: true,
      record: { applied: false, skippedReason: "duplicate-claimants" },
    });
    expect(recorder).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ taskId: "TASK-1307", verdict: "SOFT-VERIFIED" }),
      { skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"] },
      claimantIndex,
    );
  });
});
