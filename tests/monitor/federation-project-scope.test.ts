import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { mintFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { loadFederatedJob, saveFederatedJob } from "../../src/monitor/federation/store";
import { createMonitorServer } from "../../src/monitor/server";

const TOKEN = "scope-test-token";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function adapter(root: string, name: string): ProjectAdapter {
  const config = {
    version: "1.0.0",
    project: { name, root, taskDir: "docs/tasks", conventionsDir: ".quack" },
    agent: {
      model: "claude-opus-4-20250514",
      judgeModel: "claude-sonnet-4-20250514",
      enrichModel: "claude-sonnet-4-20250514",
      maxTurns: 30,
      maxBudgetPerTask: 5,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      branchPrefix: "quack",
      baseBranch: "main",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
  } as AdapterConfig;
  fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".quack", "adapter.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, ".quack", "logs", "sessions.jsonl"), "");
  return {
    projectRoot: root,
    config,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "scope-test",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

function writeAuth(quackRoot: string): void {
  const authDir = path.join(quackRoot, ".quack");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, "auth.json"),
    JSON.stringify({
      users: [],
      serviceTokens: [
        {
          id: "scope-test",
          tokenHash: crypto.createHash("sha256").update(TOKEN).digest("hex"),
          scopes: ["federation:read", "federation:write", "listener:read"],
        },
      ],
      sessionSecret: "scope-test-secret",
      sessionTtlMs: 86_400_000,
    }),
  );
}

function request(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          "X-Quack-Service-Token": TOKEN,
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += String(chunk)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function removeDir(root: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface Fixture {
  roots: [string, string];
  ids: [string, string];
  port: number;
  stop: () => Promise<void>;
  authRoot: string;
}

async function startFixture(mode: "compat" | "strict" = "compat"): Promise<Fixture> {
  const roots: [string, string] = [tempDir("quack-fed-scope-a-"), tempDir("quack-fed-scope-b-")];
  const authRoot = tempDir("quack-fed-scope-auth-");
  writeAuth(authRoot);
  const server = createMonitorServer({
    port: 0,
    host: "127.0.0.1",
    quackRoot: authRoot,
    projectAdapters: [adapter(roots[0], "scope-alpha"), adapter(roots[1], "scope-beta")],
    federationProjectScopeMode: mode,
  });
  const started = await server.start();
  const projects = await request(started.port, "GET", "/api/projects");
  const rows = projects.body as unknown as Array<{ id: string; name: string }>;
  return {
    roots,
    ids: [
      rows.find((row) => row.name === "scope-alpha")?.id ?? "scope-alpha",
      rows.find((row) => row.name === "scope-beta")?.id ?? "scope-beta",
    ],
    port: started.port,
    stop: started.stop,
    authRoot,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.stop();
  await Promise.all([...fixture.roots, fixture.authRoot].map(removeDir));
}

describe("federation lifecycle project scoping (TASK-1302)", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
  });

  it("requires scope for new multi-project lifecycle writes and stamps created jobs", async () => {
    fixture = await startFixture();

    for (const [pathname, body] of [
      ["/v1/federation/queue", { taskId: "TASK-1302", autoSchedule: false }],
      ["/v1/federation/scheduler/tick", {}],
      ["/v1/federation/jobs", { taskId: "TASK-1302" }],
    ] as const) {
      const unscoped = await request(fixture.port, "POST", pathname, body);
      expect(unscoped.status).toBe(400);
      expect(unscoped.body.code).toBe("PROJECT_SCOPE_REQUIRED");
    }

    const scoped = await request(fixture.port, "POST", "/v1/federation/queue", {
      projectId: fixture.ids[1],
      taskId: "TASK-1302",
      autoSchedule: false,
    });
    expect(scoped.status).toBe(202);
    expect((scoped.body.job as { projectId?: string }).projectId).toBe(fixture.ids[1]);
    expect((scoped.body.queued as { projectId?: string }).projectId).toBe(fixture.ids[1]);
  });

  it("lets an old unscoped worker renew a legacy uniquely owned job and warns it to upgrade", async () => {
    fixture = await startFixture();
    const jobId = "fed-task-1302-legacy-unique";
    await new ListenerRegistry(fixture.roots[0]).register(
      {
        hostId: "old-worker",
        capabilities: ["dispatch"],
        maxConcurrentJobs: 1,
      },
      "scope-test",
    );
    await saveFederatedJob(fixture.roots[0], {
      ...mintFederatedJobRecord({
        jobId,
        taskId: "TASK-1302",
        jobType: "dispatch",
        status: "assigned",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue", tokenId: "old-headnode" },
      }),
      hostId: "old-worker",
      lease: {
        leaseId: "legacy-lease-1",
        hostId: "old-worker",
        acquiredAt: "2026-09-09T00:00:00.000Z",
        expiresAt: "2099-09-09T00:30:00.000Z",
      },
    });

    const queue = await request(
      fixture.port,
      "GET",
      `/v1/federation/queue?project=${encodeURIComponent(fixture.ids[0])}`,
    );
    const legacyRead = (queue.body.jobs as Array<{ projectId?: string; jobId: string }>).find(
      (job) => job.jobId === jobId,
    );
    expect(legacyRead?.projectId).toBe(fixture.ids[0]);

    const renewed = await request(
      fixture.port,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(jobId)}/lease/renew`,
      { hostId: "old-worker", leaseId: "legacy-lease-1" },
    );
    expect(renewed.status).toBe(200);
    expect(renewed.headers["x-quack-project-scope"]).toBe("legacy-job-id-fallback");
    expect(renewed.headers.warning).toContain("Legacy unscoped federation write accepted");
    expect((renewed.body.job as { projectId?: string }).projectId).toBe(fixture.ids[0]);
  });

  it("rejects an unscoped cross-project job-id collision without mutating either job", async () => {
    fixture = await startFixture();
    const jobId = "fed-task-1302-deliberate-collision";
    await Promise.all(
      fixture.roots.map((root, index) =>
        saveFederatedJob(
          root,
          mintFederatedJobRecord({
            projectId: fixture.ids[index],
            jobId,
            taskId: `TASK-1302-${index}`,
            jobType: "dispatch",
            status: "queued",
            requiredCapabilities: ["dispatch"],
            provenance: { channel: "federation-queue", tokenId: "scope-test" },
          }),
        ),
      ),
    );

    const ambiguous = await request(
      fixture.port,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe("FEDERATED_JOB_SCOPE_AMBIGUOUS");
    expect(ambiguous.body.projects).toEqual(expect.arrayContaining(fixture.ids));
    expect((await loadFederatedJob(fixture.roots[0], jobId))?.status).toBe("queued");
    expect((await loadFederatedJob(fixture.roots[1], jobId))?.status).toBe("queued");

    const scoped = await request(
      fixture.port,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(jobId)}/cancel`,
      { projectId: fixture.ids[1] },
    );
    expect(scoped.status).toBe(200);
    expect((await loadFederatedJob(fixture.roots[0], jobId))?.status).toBe("queued");
    expect((await loadFederatedJob(fixture.roots[1], jobId))?.status).toBe("canceled");
  });

  it("supports a strict rollout mode after every worker sends project scope", async () => {
    fixture = await startFixture("strict");
    const jobId = "fed-task-1302-strict";
    await saveFederatedJob(
      fixture.roots[0],
      mintFederatedJobRecord({
        projectId: fixture.ids[0],
        jobId,
        taskId: "TASK-1302",
        jobType: "dispatch",
        status: "queued",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue", tokenId: "scope-test" },
      }),
    );

    const response = await request(
      fixture.port,
      "POST",
      `/v1/federation/jobs/${encodeURIComponent(jobId)}/lease/renew`,
      { hostId: "old-worker" },
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("PROJECT_SCOPE_REQUIRED");
  });
});
