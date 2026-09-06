import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { workerInstallCommand } from "../../src/cli/worker";

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

describe("workerInstallCommand", () => {
  const originalFetch = global.fetch;
  let workerRoot: string;
  let consoleSpy: jest.SpyInstance;
  let logLines: string[];

  beforeEach(() => {
    workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-worker-install-"));
    logLines = [];
    consoleSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
    fs.rmSync(workerRoot, { recursive: true, force: true });
  });

  it("consumes a bootstrap manifest in dry-run mode without cloning or starting processes", async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              ok: true,
              session: {
                enrollmentId: "worker-enrollment-123",
                hostId: "contributor-laptop",
              },
              manifest: {
                version: "worker-enrollment-v1",
                enrollmentId: "worker-enrollment-123",
                issuedAt: "2026-05-04T12:00:00.000Z",
                expiresAt: "2026-05-04T13:00:00.000Z",
                controlPlane: {
                  baseUrl: "http://headnode.test:3333",
                  runtimeRole: "headnode",
                },
                worker: {
                  hostId: "contributor-laptop",
                  alias: "Contributor Laptop",
                  capabilities: ["dispatch", "verify"],
                  maxConcurrentJobs: 2,
                  runtimePort: 3337,
                  persistence: "manual",
                  pollMs: 12000,
                },
                prerequisites: [],
                repos: [
                  {
                    id: "quack",
                    label: "Quack",
                    sourceUrl: "https://example.test/quack.git",
                    branch: "main",
                    destination: "Quack",
                    required: true,
                  },
                  {
                    id: "example",
                    label: "Example Assistant MVP",
                    sourceUrl: "https://example.test/example.git",
                    branch: "dev",
                    destination: "example-service",
                    required: true,
                  },
                ],
                projects: [
                  {
                    id: "example-service",
                    label: "Example Assistant MVP",
                    repoId: "example",
                    pathAlias: "example",
                    primary: true,
                    installCommands: [
                      {
                        cmd: "npm",
                        args: ["ci"],
                        description: "Install dependencies",
                      },
                    ],
                    probeCommands: [],
                  },
                ],
                env: [
                  {
                    name: "NODE_ENV",
                    mode: "manual",
                    placeholder: "test",
                  },
                ],
                secrets: [],
                manualSteps: ["Confirm Tailscale auth."],
              },
              workerToken: {
                id: "worker-contributor",
                token: "qsvc_test_token",
                scopes: [
                  "listener:register",
                  "listener:read",
                  "listener:heartbeat",
                  "federation:write",
                ],
              },
            }),
          ),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await workerInstallCommand({
      bootstrapToken: "qenr_test_bootstrap",
      controlBaseUrl: "http://headnode.test:3333",
      targetRoot: workerRoot,
      dryRun: true,
    });

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected fetch to be called once.");
    }
    const [calledUrl, calledInit] = firstCall as unknown as [string, RequestInit];
    const calledHeaders = parseJson<Record<string, string>>(
      JSON.stringify(calledInit.headers ?? {}),
    );
    expect(calledUrl).toBe("http://headnode.test:3333/v1/workers/bootstrap");
    expect(calledInit.method).toBe("POST");
    expect(calledHeaders.Authorization).toBe("Bearer qenr_test_bootstrap");
    expect(fs.existsSync(workerRoot)).toBe(true);
    expect(fs.existsSync(path.join(workerRoot, "Quack"))).toBe(false);
    expect(logLines.join("\n")).toContain("Worker enrollment worker-enrollment-123 prepared.");
    expect(logLines.join("\n")).toContain("Runtime:       http://127.0.0.1:3337/api/health");
    expect(logLines.join("\n")).toContain("Readiness:");
    expect(logLines.join("\n")).toContain("Repo freshness:");
    expect(logLines.join("\n")).toContain("Quack -> main");
    expect(logLines.join("\n")).toContain("Example Assistant MVP -> dev");
    expect(logLines.join("\n")).toContain("Manual steps:");
    expect(logLines.join("\n")).toContain("Confirm Tailscale auth.");
  });
});
