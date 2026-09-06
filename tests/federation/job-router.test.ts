import { routeFederatedJob } from "../../src/federation/job-router";
import type { FederatedHost } from "../../src/federation/host-registry";

const hosts: FederatedHost[] = [
  {
    id: "headnode",
    capabilities: ["dispatch", "verify", "fix"],
    enabled: true,
    healthy: true,
  },
  {
    id: "worker-b",
    capabilities: ["dispatch"],
    enabled: true,
    healthy: false,
  },
];

describe("routeFederatedJob", () => {
  it("chooses a healthy capable host", () => {
    const result = routeFederatedJob({
      taskId: "TASK-838",
      jobType: "verify",
      hosts,
    });

    expect(result).toMatchObject({
      ok: true,
      host: { id: "headnode" },
      fallbackUsed: false,
      requiredCapabilities: ["verify"],
    });
  });

  it("falls back deterministically when the preferred host is unhealthy", () => {
    const result = routeFederatedJob({
      taskId: "TASK-838",
      jobType: "dispatch",
      preferredHostId: "worker-b",
      hosts,
    });

    expect(result).toMatchObject({
      ok: true,
      host: { id: "headnode" },
      fallbackUsed: true,
    });
  });

  it("returns host_unhealthy when no healthy fallback exists", () => {
    const result = routeFederatedJob({
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [hosts[1]],
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      blockReasonCode: "host_unhealthy",
      error: "host_unhealthy",
    });
  });

  it("returns pending_remote_listener when no capable host exists", () => {
    const result = routeFederatedJob({
      taskId: "TASK-838",
      jobType: "fix",
      hosts: [hosts[1]],
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      blockReasonCode: "pending_remote_listener",
      error: "no_capable_listener",
    });
  });

  it("does not assign overloaded hosts", () => {
    const result = routeFederatedJob({
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "contributor-laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
          currentLoad: 1,
          maxConcurrentJobs: 1,
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      blockReasonCode: "pending_remote_listener",
      error: "host_at_capacity",
    });
  });
});
