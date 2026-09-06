/* eslint-disable @typescript-eslint/no-base-to-string */
import { workerEnrollCommand } from "../../src/cli/worker";

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

describe("workerEnrollCommand", () => {
  const originalFetch = global.fetch;
  let consoleSpy: jest.SpyInstance;
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    consoleSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
  });

  it("creates a headnode enrollment bundle with populated install and repair commands", async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              session: {
                enrollmentId: "worker-enrollment-123",
                hostId: "contributor-gaming-machine",
                alias: "Contributor Gaming Machine",
                profileId: "example-worker",
                projectId: "example-service-dev",
                createdAt: "2026-05-05T03:00:00.000Z",
                expiresAt: "2026-05-05T04:00:00.000Z",
                createdBy: "operator",
                status: "pending",
                runtimePort: 3337,
                capabilities: ["dispatch", "verify", "fix", "backend"],
                persistence: "scheduled-task-logon",
                installStatus: {
                  state: "pending",
                  progressPercent: 0,
                  bootstrapConsumed: false,
                  listenerRegistered: false,
                  listenerHealthy: false,
                  runtimeHealthy: false,
                  manualFollowUpPending: true,
                  manualFollowUpCount: 1,
                  requestedCapabilities: ["dispatch", "verify", "fix", "backend"],
                  advertisedCapabilities: ["dispatch", "verify", "fix", "backend"],
                  capabilityWarnings: [],
                },
                listener: null,
              },
              bootstrapToken: "qenr_test_bootstrap",
              installCommand:
                "export WORKER_ROOT='/home/contributor/quack-worker' && node dist/index.js worker install --control-base-url http://headnode.test:3333 --bootstrap-token qenr_test_bootstrap --target-root \"$WORKER_ROOT\" --start",
              installCommandWindows:
                "$workerRoot = 'C:\\Users\\Contributor\\QuackWorkers\\contributor-gaming-machine'; node .\\dist\\index.js worker install --control-base-url http://headnode.test:3333 --bootstrap-token qenr_test_bootstrap --target-root $workerRoot --start",
              repairCommand:
                "export WORKER_ROOT='/home/contributor/quack-worker' && node dist/index.js worker install --control-base-url http://headnode.test:3333 --bootstrap-token qenr_test_bootstrap --target-root \"$WORKER_ROOT\" --repair --start",
              repairCommandWindows:
                "$workerRoot = 'C:\\Users\\Contributor\\QuackWorkers\\contributor-gaming-machine'; node .\\dist\\index.js worker install --control-base-url http://headnode.test:3333 --bootstrap-token qenr_test_bootstrap --target-root $workerRoot --repair --start",
              targetRoots: {
                windows: "C:\\Users\\Contributor\\QuackWorkers\\contributor-gaming-machine",
                posix: "/home/contributor/quack-worker",
              },
              manifestPreview: {
                version: "worker-enrollment-v1",
                enrollmentId: "worker-enrollment-123",
                issuedAt: "2026-05-05T03:00:00.000Z",
                expiresAt: "2026-05-05T04:00:00.000Z",
                controlPlane: {
                  baseUrl: "http://headnode.test:3333",
                  runtimeRole: "headnode",
                },
                worker: {
                  hostId: "contributor-gaming-machine",
                  alias: "Contributor Gaming Machine",
                  capabilities: ["dispatch", "verify", "fix", "backend"],
                  maxConcurrentJobs: 1,
                  runtimePort: 3337,
                  persistence: "scheduled-task-logon",
                  pollMs: 15000,
                },
                prerequisites: [
                  {
                    id: "git",
                    label: "Git",
                    required: true,
                    checkCommand: {
                      cmd: "git",
                      args: ["--version"],
                    },
                  },
                ],
                repos: [],
                projects: [],
                env: [],
                secrets: [],
                manualSteps: ["Confirm Tailscale auth."],
              },
              progressEvents: [],
              capabilityResults: [],
            }),
          ),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await workerEnrollCommand({
      controlBaseUrl: "http://headnode.test:3333",
      apiKey: "api_key_test",
      hostId: "contributor-gaming-machine",
      alias: "Contributor Gaming Machine",
      profileId: "example-worker",
      projectId: "example-service-dev",
      targetRootWindows: "C:\\Users\\Contributor\\QuackWorkers\\contributor-gaming-machine",
      targetRootPosix: "/home/contributor/quack-worker",
    });

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected fetch to be called.");
    }
    const [calledUrl, calledInit] = firstCall as unknown as [string, RequestInit];
    const calledHeaders = parseJson<Record<string, string>>(
      JSON.stringify(calledInit.headers ?? {}),
    );
    const calledBody = parseJson<Record<string, unknown>>(String(calledInit.body));
    expect(calledUrl).toBe("http://headnode.test:3333/api/workers/enrollments");
    expect(calledInit.method).toBe("POST");
    expect(calledHeaders["X-API-Key"]).toBe("api_key_test");
    expect(calledBody).toMatchObject({
      hostId: "contributor-gaming-machine",
      alias: "Contributor Gaming Machine",
      profileId: "example-worker",
      projectId: "example-service-dev",
      targetRootWindows: "C:\\Users\\Contributor\\QuackWorkers\\contributor-gaming-machine",
      targetRootPosix: "/home/contributor/quack-worker",
    });

    const output = logLines.join("\n");
    expect(output).toContain("Worker enrollment worker-enrollment-123 created.");
    expect(output).toContain("Token:        qenr_test_bootstrap");
    expect(output).toContain("Windows install:");
    expect(output).toContain("Windows repair:");
    expect(output).toContain("--repair --start");
    expect(output).toContain("/home/contributor/quack-worker");
  });
});
