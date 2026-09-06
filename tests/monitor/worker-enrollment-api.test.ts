/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({
    users: [],
    serviceTokens: [],
    sessionSecret: "test",
    sessionTtlMs: 86400000,
  }),
}));

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function writeGlobalConfig(homeDir: string): void {
  const quackDir = path.join(homeDir, ".quack");
  fs.mkdirSync(quackDir, { recursive: true });
  fs.writeFileSync(
    path.join(quackDir, "config.json"),
    JSON.stringify(
      {
        projects: [],
        monitor: { port: 3333 },
        workerProfiles: [
          {
            id: "example-worker",
            label: "Example worker",
            controlBaseUrl: "http://headnode.test:3333",
            runtimePort: 3337,
            maxConcurrentJobs: 2,
            pollMs: 12000,
            persistence: "scheduled-task-startup",
            capabilities: ["dispatch", "verify"],
            repos: [
              {
                id: "quack",
                label: "Quack",
                sourceUrl: "https://oauth2:github-test-token@example.test/quack.git",
                branch: "main",
                destination: "Quack",
                required: true,
              },
              {
                id: "example",
                label: "Example Assistant MVP",
                sourceUrl: "https://oauth2:github-test-token@example.test/example.git",
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
                probeCommands: [
                  {
                    cmd: "npm",
                    args: ["test", "--", "Smoke"],
                    description: "Run smoke test",
                  },
                ],
                capabilityProbes: [
                  {
                    capability: "backend",
                    description: "Prove backend capability",
                    command: {
                      cmd: "npm",
                      args: ["test", "--", "BackendSmoke"],
                      description: "Run backend smoke",
                    },
                  },
                ],
              },
            ],
            manualSteps: ["Confirm Tailscale auth."],
            env: [
              {
                name: "NODE_ENV",
                mode: "inline",
                value: "test",
                description: "Worker runtime mode",
              },
            ],
            secrets: [
              {
                id: "test_api_key",
                mode: "manual",
                envName: "TEST_API_KEY",
                placeholder: "TODO_TEST_API_KEY",
                description: "Scoped test API key",
              },
            ],
          },
          {
            id: "generic-worker",
            label: "Generic worker",
            runtimePort: 3340,
            maxConcurrentJobs: 1,
            pollMs: 15000,
            persistence: "manual",
            capabilities: ["dispatch", "verify", "fix"],
            repos: [
              {
                id: "quack",
                label: "Quack",
                sourceUrl: "https://oauth2:github-test-token@example.test/quack.git",
                branch: "main",
                destination: "Quack",
                required: true,
              },
            ],
            projects: [
              {
                id: "quack",
                label: "Quack",
                repoId: "quack",
                pathAlias: "quack",
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
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    body: await response.text(),
  };
}

async function httpPost(
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

describe("worker enrollment API", () => {
  let homeDir: string;
  let projectRoot: string;
  let quackRoot: string;
  let stopServer: (() => Promise<void>) | undefined;
  let baseUrl: string;
  let previousQuackHome: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    previousQuackHome = process.env.QUACK_HOME;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    homeDir = makeTempDir("quack-home-");
    projectRoot = makeTempDir("quack-worker-enrollment-project-");
    quackRoot = makeTempDir("quack-worker-enrollment-root-");
    process.env.QUACK_HOME = homeDir;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeGlobalConfig(homeDir);

    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });

    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port,
    });
    const started = await server.start();
    stopServer = started.stop;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    if (typeof previousQuackHome === "string") {
      process.env.QUACK_HOME = previousQuackHome;
    } else {
      delete process.env.QUACK_HOME;
    }
    if (typeof previousHome === "string") {
      process.env.HOME = previousHome;
    } else {
      delete process.env.HOME;
    }
    if (typeof previousUserProfile === "string") {
      process.env.USERPROFILE = previousUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    removeTempDir(projectRoot);
    removeTempDir(quackRoot);
    removeTempDir(homeDir);
  });

  it("lists configured worker enrollment profiles", async () => {
    const response = await httpGet(`${baseUrl}/api/workers/enrollment-profiles`);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      profiles: expect.arrayContaining([
        expect.objectContaining({
          id: "example-worker",
          label: "Example worker",
          runtimePort: 3337,
          maxConcurrentJobs: 2,
          persistence: "scheduled-task-startup",
          capabilities: ["dispatch", "verify"],
          projectIds: ["example-service"],
          defaultProjectId: "example-service",
        }),
      ]),
    });
  });

  it("creates an enrollment, returns install commands, and consumes the bootstrap token once", async () => {
    const created = await httpPost(`${baseUrl}/api/workers/enrollments`, {
      hostId: "Contributor Laptop",
      alias: "Contributor Laptop",
      profileId: "example-worker",
      projectId: "example-service",
      targetRootWindows: "C:\\Users\\Contributor\\QuackWorkers\\contributor-laptop",
      targetRootPosix: "/home/contributor/quack-workers/contributor-laptop",
    });
    expect(created.status).toBe(201);
    const createdBody = JSON.parse(created.body) as {
      session: {
        enrollmentId: string;
        hostId: string;
        status: string;
        persistence: string;
        installStatus: {
          state: string;
          requestedCapabilities: string[];
          advertisedCapabilities: string[];
        };
      };
      bootstrapToken: string;
      installCommand: string;
      installCommandWindows: string;
      repairCommand: string;
      repairCommandWindows: string;
      targetRoots: {
        windows?: string;
        posix?: string;
      };
      manifestPreview: {
        repos: Array<{ sourceUrl: string }>;
        projects: Array<{ capabilityProbes?: Array<{ capability: string }> }>;
        env: Array<{
          name: string;
          mode: string;
          value?: string;
          placeholder?: string;
          secretRef?: string;
        }>;
        manualSteps: string[];
      };
      progressEvents: Array<{ phase: string; state: string }>;
      capabilityResults: Array<{ capability: string; status: string }>;
    };
    expect(createdBody.session).toMatchObject({
      hostId: "contributor-laptop",
      projectId: "example-service",
      status: "pending",
      persistence: "scheduled-task-startup",
      installStatus: {
        state: "pending",
        requestedCapabilities: ["dispatch", "verify"],
        advertisedCapabilities: ["dispatch", "verify"],
      },
    });
    expect(createdBody.bootstrapToken).toMatch(/^qenr_/);
    expect(createdBody.installCommand).toContain("node dist/index.js worker install");
    expect(createdBody.installCommandWindows).toContain("node .\\dist\\index.js worker install");
    expect(createdBody.repairCommand).toContain("--repair --start");
    expect(createdBody.repairCommandWindows).toContain("--repair --start");
    expect(createdBody.installCommand).toContain("npm --prefix frontend ci");
    expect(createdBody.installCommandWindows).toContain("npm --prefix frontend ci");
    expect(createdBody.installCommandWindows).toContain(
      "C:\\Users\\Contributor\\QuackWorkers\\contributor-laptop",
    );
    expect(createdBody.installCommand).toContain(
      "/home/contributor/quack-workers/contributor-laptop",
    );
    expect(createdBody.installCommand).not.toContain("github-test-token");
    expect(createdBody.installCommandWindows).not.toContain("github-test-token");
    expect(createdBody.targetRoots).toEqual({
      windows: "C:\\Users\\Contributor\\QuackWorkers\\contributor-laptop",
      posix: "/home/contributor/quack-workers/contributor-laptop",
    });
    expect(createdBody.manifestPreview.repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceUrl: "https://example.test/quack.git" }),
        expect.objectContaining({ sourceUrl: "https://example.test/example.git" }),
      ]),
    );
    expect(createdBody.manifestPreview.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityProbes: expect.arrayContaining([
            expect.objectContaining({ capability: "backend" }),
          ]),
        }),
      ]),
    );
    expect(createdBody.manifestPreview.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "NODE_ENV",
          mode: "inline",
        }),
        expect.objectContaining({
          name: "TEST_API_KEY",
          mode: "manual",
          placeholder: "TODO_TEST_API_KEY",
          secretRef: "test_api_key",
        }),
      ]),
    );
    expect(createdBody.manifestPreview.manualSteps).toEqual(
      expect.arrayContaining([
        "Confirm Tailscale auth.",
        "Fill TEST_API_KEY (test_api_key) before advertising workloads that require it.",
        expect.stringContaining("Configure a git credential helper"),
      ]),
    );
    expect(createdBody.progressEvents).toEqual([]);
    expect(createdBody.capabilityResults).toEqual([]);

    const listed = await httpGet(`${baseUrl}/api/workers/enrollments`);
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      ok: true,
      sessions: [
        expect.objectContaining({
          enrollmentId: createdBody.session.enrollmentId,
          status: "pending",
          installStatus: expect.objectContaining({
            state: "pending",
          }),
        }),
      ],
    });

    const bootstrapped = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      {
        Authorization: `Bearer ${createdBody.bootstrapToken}`,
      },
    );
    expect(bootstrapped.status).toBe(200);
    const bootstrapBody = JSON.parse(bootstrapped.body) as {
      session: {
        status: string;
        consumedAt?: string;
        installStatus: { state: string };
      };
      manifest: {
        version: string;
        controlPlane: { baseUrl: string; runtimeRole: string };
        worker: { hostId: string; persistence: string; capabilities: string[] };
        repos: Array<{ sourceUrl: string }>;
        env: Array<Record<string, unknown>>;
        manualSteps: string[];
      };
      workerToken: { id: string; token: string; scopes: string[] };
    };
    expect(bootstrapBody.session.status).toBe("consumed");
    expect(bootstrapBody.session.installStatus.state).toBe("bootstrap_consumed");
    expect(bootstrapBody.manifest).toMatchObject({
      version: "worker-enrollment-v1",
      controlPlane: {
        baseUrl: "http://headnode.test:3333",
        runtimeRole: "headnode",
      },
      worker: {
        hostId: "contributor-laptop",
        persistence: "scheduled-task-startup",
        capabilities: ["dispatch", "verify"],
      },
    });
    expect(bootstrapBody.manifest.manualSteps).toEqual(
      expect.arrayContaining([
        "Confirm Tailscale auth.",
        "Fill TEST_API_KEY (test_api_key) before advertising workloads that require it.",
        expect.stringContaining("Configure a git credential helper"),
      ]),
    );
    expect(bootstrapBody.manifest.repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceUrl: "https://example.test/quack.git" }),
        expect.objectContaining({ sourceUrl: "https://example.test/example.git" }),
      ]),
    );
    expect(bootstrapBody.manifest.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "NODE_ENV",
          mode: "inline",
          value: "test",
        }),
        expect.objectContaining({
          name: "TEST_API_KEY",
          mode: "manual",
          placeholder: "TODO_TEST_API_KEY",
          secretRef: "test_api_key",
        }),
      ]),
    );
    expect(bootstrapBody.workerToken.token).toMatch(/^qsvc_/);
    expect(bootstrapBody.workerToken.scopes).toEqual(
      expect.arrayContaining([
        "listener:register",
        "listener:read",
        "listener:heartbeat",
        "federation:write",
      ]),
    );

    const progress = await httpPost(
      `${baseUrl}/v1/workers/enrollments/${createdBody.session.enrollmentId}/progress`,
      {
        events: [
          {
            phase: "repo_sync",
            state: "completed",
            message: "Synced worker repos.",
          },
        ],
        capabilityResults: [
          {
            capability: "backend",
            status: "passed",
            projectId: "example-service",
            message: "Backend probe passed.",
            command: {
              cmd: "npm",
              args: ["test", "--", "BackendSmoke"],
            },
          },
        ],
      },
      {
        "X-Quack-Service-Token": bootstrapBody.workerToken.token,
      },
    );
    expect(progress.status).toBe(200);

    const registered = await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId: "contributor-laptop",
        alias: "Contributor Laptop",
        capabilities: ["dispatch", "verify", "backend"],
        maxConcurrentJobs: 2,
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
        metadata: {
          localRuntime: "online",
        },
      },
      {
        "X-Quack-Service-Token": bootstrapBody.workerToken.token,
      },
    );
    expect(registered.status).toBe(201);

    const heartbeat = await httpPost(
      `${baseUrl}/v1/listeners/contributor-laptop/heartbeat`,
      {
        healthy: true,
        currentLoad: 0,
        maxConcurrentJobs: 2,
        capabilities: ["dispatch", "verify", "backend"],
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
        metadata: {
          localRuntime: "online",
        },
      },
      {
        "X-Quack-Service-Token": bootstrapBody.workerToken.token,
      },
    );
    expect(heartbeat.status).toBe(200);

    const detail = await httpGet(
      `${baseUrl}/api/workers/enrollments/${createdBody.session.enrollmentId}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = parseJson<{
      ok: boolean;
      session: {
        enrollmentId: string;
        status: string;
        installStatus: {
          state: string;
          advertisedCapabilities: string[];
        };
        readiness: {
          status: string;
          score: number;
          trustedForWork: boolean;
          blockedCapabilities: string[];
          blockers: string[];
          repoFreshness: Array<{
            repoId: string;
            status: string;
            dirty: boolean;
            currentBranch?: string;
          }>;
          capabilities: Array<{ capability: string; tier: string; status: string }>;
          repairActions: Array<{ command: string }>;
        };
        listener?: {
          healthy: boolean;
        } | null;
      };
      manifestPreview: {
        repos: Array<{ sourceUrl: string }>;
      };
      progressEvents: Array<{ phase: string; state: string }>;
      capabilityResults: Array<{ capability: string; status: string }>;
    }>(detail.body);
    expect(detailBody.ok).toBe(true);
    expect(detailBody.session).toMatchObject({
      enrollmentId: createdBody.session.enrollmentId,
      status: "consumed",
      installStatus: {
        state: "healthy",
        advertisedCapabilities: expect.arrayContaining(["dispatch", "verify", "backend"]),
      },
      listener: {
        healthy: true,
      },
    });
    expect(detailBody.session.readiness).toMatchObject({
      status: "blocked",
      trustedForWork: false,
      blockedCapabilities: expect.arrayContaining(["auth"]),
    });
    expect(detailBody.session.readiness.score).toBeLessThan(100);
    expect(detailBody.session.readiness.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("TEST_API_KEY")]),
    );
    expect(detailBody.session.readiness.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "dispatch", tier: "base", status: "deferred" }),
        expect.objectContaining({ capability: "backend", tier: "project", status: "passed" }),
        expect.objectContaining({ capability: "auth", tier: "auth", status: "withheld" }),
      ]),
    );
    expect(detailBody.session.readiness.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: expect.stringContaining("--repair --start") }),
        expect.objectContaining({ command: expect.stringContaining("TEST_API_KEY") }),
      ]),
    );
    expect(detailBody.manifestPreview.repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceUrl: "https://example.test/quack.git" }),
        expect.objectContaining({ sourceUrl: "https://example.test/example.git" }),
      ]),
    );
    expect(detailBody.progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "bootstrap", state: "completed" }),
        expect.objectContaining({ phase: "repo_sync", state: "completed" }),
      ]),
    );
    expect(detailBody.capabilityResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "backend", status: "passed" }),
      ]),
    );

    const reused = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      {
        Authorization: `Bearer ${createdBody.bootstrapToken}`,
      },
    );
    expect(reused.status).toBe(409);
    expect(JSON.parse(reused.body)).toMatchObject({
      error: "worker_bootstrap_token_consumed",
    });
  });

  it("marks a clean registered worker trusted when repo freshness and probes are healthy", async () => {
    const created = await httpPost(`${baseUrl}/api/workers/enrollments`, {
      hostId: "Trusted Worker",
      profileId: "generic-worker",
      projectId: "quack",
    });
    const createdBody = parseJson<{
      session: { enrollmentId: string };
      bootstrapToken: string;
    }>(created.body);
    const bootstrapped = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      { Authorization: `Bearer ${createdBody.bootstrapToken}` },
    );
    const bootstrapBody = parseJson<{ workerToken: { token: string } }>(bootstrapped.body);

    const progress = await httpPost(
      `${baseUrl}/v1/workers/enrollments/${createdBody.session.enrollmentId}/progress`,
      {
        events: [
          {
            phase: "repo_sync",
            state: "completed",
            message: "Repos are current.",
            metadata: {
              repoFreshness: [
                {
                  repoId: "quack",
                  label: "Quack",
                  sourceUrl: "https://example.test/quack.git",
                  expectedBranch: "main",
                  path: "/workers/Trusted/Quack",
                  exists: true,
                  currentBranch: "main",
                  localCommit: "abc123",
                  remoteCommit: "abc123",
                  dirty: false,
                  ahead: 0,
                  behind: 0,
                  fastForwarded: false,
                  status: "current",
                  blockers: [],
                },
              ],
            },
          },
        ],
        capabilityResults: [
          { capability: "dispatch", status: "deferred", message: "Runtime-gated." },
          { capability: "verify", status: "deferred", message: "Runtime-gated." },
          { capability: "fix", status: "deferred", message: "Runtime-gated." },
        ],
      },
      { "X-Quack-Service-Token": bootstrapBody.workerToken.token },
    );
    expect(progress.status).toBe(200);

    await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId: "trusted-worker",
        alias: "Trusted Worker",
        capabilities: ["dispatch", "verify", "fix"],
        maxConcurrentJobs: 1,
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
        metadata: { localRuntime: "online" },
      },
      { "X-Quack-Service-Token": bootstrapBody.workerToken.token },
    );
    await httpPost(
      `${baseUrl}/v1/listeners/trusted-worker/heartbeat`,
      {
        healthy: true,
        currentLoad: 0,
        maxConcurrentJobs: 1,
        capabilities: ["dispatch", "verify", "fix"],
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
        metadata: { localRuntime: "online" },
      },
      { "X-Quack-Service-Token": bootstrapBody.workerToken.token },
    );

    const detail = await httpGet(
      `${baseUrl}/api/workers/enrollments/${createdBody.session.enrollmentId}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = parseJson<{
      session: {
        readiness: {
          status: string;
          score: number;
          trustedForWork: boolean;
          blockers: string[];
          blockedCapabilities: string[];
          repoFreshness: Array<{ repoId: string; status: string; dirty: boolean }>;
        };
      };
    }>(detail.body);
    expect(detailBody.session.readiness).toMatchObject({
      status: "ready",
      score: 100,
      trustedForWork: true,
      blockers: [],
      blockedCapabilities: [],
      repoFreshness: [
        expect.objectContaining({ repoId: "quack", status: "current", dirty: false }),
      ],
    });
  });

  it("withholds execution trust when repo freshness reports wrong branch or dirty state", async () => {
    const created = await httpPost(`${baseUrl}/api/workers/enrollments`, {
      hostId: "Dirty Worker",
      profileId: "generic-worker",
      projectId: "quack",
    });
    const createdBody = parseJson<{
      session: { enrollmentId: string };
      bootstrapToken: string;
    }>(created.body);
    const bootstrapped = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      { Authorization: `Bearer ${createdBody.bootstrapToken}` },
    );
    const bootstrapBody = parseJson<{ workerToken: { token: string } }>(bootstrapped.body);

    const progress = await httpPost(
      `${baseUrl}/v1/workers/enrollments/${createdBody.session.enrollmentId}/progress`,
      {
        events: [
          {
            phase: "repo_sync",
            state: "completed",
            message: "Repo sync needs operator attention.",
            metadata: {
              repoFreshness: [
                {
                  repoId: "quack",
                  label: "Quack",
                  sourceUrl: "https://example.test/quack.git",
                  expectedBranch: "main",
                  path: "/workers/Dirty/Quack",
                  exists: true,
                  currentBranch: "feature/debug",
                  localCommit: "abc123",
                  remoteCommit: "def456",
                  dirty: true,
                  ahead: 1,
                  behind: 2,
                  fastForwarded: false,
                  status: "wrong_branch",
                  blockers: [
                    "Quack is on feature/debug instead of main.",
                    "Quack has uncommitted changes.",
                  ],
                  repairCommand: "git -C /workers/Dirty/Quack status --short",
                },
              ],
            },
          },
        ],
        capabilityResults: [
          { capability: "dispatch", status: "deferred", message: "Runtime-gated." },
          { capability: "verify", status: "deferred", message: "Runtime-gated." },
          { capability: "fix", status: "deferred", message: "Runtime-gated." },
        ],
      },
      { "X-Quack-Service-Token": bootstrapBody.workerToken.token },
    );
    expect(progress.status).toBe(200);

    const detail = await httpGet(
      `${baseUrl}/api/workers/enrollments/${createdBody.session.enrollmentId}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = parseJson<{
      session: {
        readiness: {
          status: string;
          trustedForWork: boolean;
          blockedCapabilities: string[];
          blockers: string[];
          repoFreshness: Array<{
            repoId: string;
            status: string;
            dirty: boolean;
            currentBranch?: string;
          }>;
          repairActions: Array<{ command: string }>;
        };
      };
    }>(detail.body);
    expect(detailBody.session.readiness).toMatchObject({
      status: "blocked",
      trustedForWork: false,
      blockedCapabilities: expect.arrayContaining(["dispatch", "verify", "fix"]),
      repoFreshness: [
        expect.objectContaining({
          repoId: "quack",
          status: "wrong_branch",
          dirty: true,
          currentBranch: "feature/debug",
        }),
      ],
    });
    expect(detailBody.session.readiness.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("feature/debug"),
        expect.stringContaining("uncommitted changes"),
      ]),
    );
    expect(detailBody.session.readiness.repairActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "git -C /workers/Dirty/Quack status --short" }),
      ]),
    );
  });

  it("rejects missing, invalid, and expired bootstrap tokens", async () => {
    const created = await httpPost(`${baseUrl}/api/workers/enrollments`, {
      hostId: "Worker-B",
      profileId: "example-worker",
    });
    const createdBody = JSON.parse(created.body) as {
      session: { enrollmentId: string };
      bootstrapToken: string;
    };

    const missing = await httpPost(`${baseUrl}/v1/workers/bootstrap`, {});
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body)).toMatchObject({
      error: "worker_bootstrap_token_required",
    });

    const invalid = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      {
        Authorization: "Bearer qenr_invalid",
      },
    );
    expect(invalid.status).toBe(401);
    expect(JSON.parse(invalid.body)).toMatchObject({
      error: "worker_bootstrap_token_invalid",
    });

    const recordPath = path.join(
      projectRoot,
      ".quack",
      "worker-enrollments",
      `${createdBody.session.enrollmentId}.json`,
    );
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    record.expiresAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", "utf-8");

    const expired = await httpPost(
      `${baseUrl}/v1/workers/bootstrap`,
      {},
      {
        Authorization: `Bearer ${createdBody.bootstrapToken}`,
      },
    );
    expect(expired.status).toBe(410);
    expect(JSON.parse(expired.body)).toMatchObject({
      error: "worker_bootstrap_token_expired",
    });
  });

  it("uses the request origin for generated install commands when the profile does not pin a control base URL", async () => {
    const created = await httpPost(`${baseUrl}/api/workers/enrollments`, {
      hostId: "Generic Worker",
      profileId: "generic-worker",
      projectId: "quack",
    });
    expect(created.status).toBe(201);
    const createdBody = JSON.parse(created.body) as {
      installCommand: string;
      installCommandWindows: string;
      repairCommand: string;
      repairCommandWindows: string;
      manifestPreview: {
        controlPlane: {
          baseUrl: string;
        };
      };
    };
    expect(createdBody.manifestPreview.controlPlane.baseUrl).toBe(baseUrl);
    expect(createdBody.installCommand).toContain(`--control-base-url ${baseUrl}`);
    expect(createdBody.installCommandWindows).toContain(`--control-base-url ${baseUrl}`);
    expect(createdBody.repairCommand).toContain(`--control-base-url ${baseUrl}`);
    expect(createdBody.repairCommandWindows).toContain(`--control-base-url ${baseUrl}`);
  });
});
