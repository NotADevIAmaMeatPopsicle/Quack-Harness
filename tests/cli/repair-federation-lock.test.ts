import { repairFederationLockCommand } from "../../src/cli/repair-federation-lock";
import { repairFederatedJobLockOffline } from "../../src/monitor/federation/offline-lock-recovery";

jest.mock("../../src/monitor/federation/offline-lock-recovery", () => ({
  repairFederatedJobLockOffline: jest.fn(),
}));

describe("repair-federation-lock CLI", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("reports orphaned staging cleanup as an applied mutation", async () => {
    (
      repairFederatedJobLockOffline as jest.MockedFunction<typeof repairFederatedJobLockOffline>
    ).mockResolvedValue({
      status: "staging-cleaned",
      applied: true,
      jobId: "job-staging-cleanup",
      fingerprint: "a".repeat(64),
      lockPath: "C:\\project\\.quack\\federation\\jobs\\job-staging-cleanup.lock",
      removedArtifacts: 1,
    });
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await repairFederationLockCommand("job-staging-cleanup", {
      project: "C:\\project",
      apply: true,
      confirmOffline: true,
      expectedFingerprint: "a".repeat(64),
    });

    expect(log.mock.calls.flat().join("\n")).toContain("Cleaned orphaned offline recovery staging");
    expect(log.mock.calls.flat().join("\n")).toContain("Artifacts removed: 1");
    expect(error).not.toHaveBeenCalled();
  });
});
