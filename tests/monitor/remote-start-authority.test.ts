import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { generateProjectId } from "../../src/monitor/project-registry";
import { saveFederatedJob } from "../../src/monitor/federation/store";
import type { FederatedJobRecord } from "../../src/monitor/federation/types";
import { withTaskCreationReservation } from "../../src/core/task-creation-reservation";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-direct-dispatch-guard-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function writeListener(projectRoot: string): void {
  const listenersDir = path.join(projectRoot, ".quack", "federation", "listeners");
  fs.mkdirSync(listenersDir, { recursive: true });
  fs.writeFileSync(
    path.join(listenersDir, "laptop.json"),
    JSON.stringify({
      id: "laptop",
      alias: "Laptop",
      capabilities: ["dispatch"],
      enabled: true,
      healthy: true,
      currentLoad: 0,
      maxConcurrentJobs: 1,
      registeredAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z",
    }),
    "utf-8",
  );
}

function writeTask(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, "docs", "tasks", "TASK-001-fixture.md"),
    [
      "# TASK-001: Guard Fixture",
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 1-2 hours",
      "- **Status:** READY",
      "- **Blocked By:** []",
      "- **Tags:** [test]",
      "",
      "## Problem Statement",
      "Fixture task.",
      "",
      "## Success Criteria",
      "- [ ] Guard behavior is deterministic",
      "",
      "## Testing Requirements",
      "- [ ] API test passes",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function writeFederatedClaim(
  projectRoot: string,
  overrides: Partial<FederatedJobRecord> = {},
): Promise<FederatedJobRecord> {
  const now = new Date().toISOString();
  const record: FederatedJobRecord = {
    projectId: generateProjectId(projectRoot),
    jobId: "fed-TASK-001",
    taskId: "TASK-001",
    jobType: "dispatch",
    status: "assigned",
    correlationId: "fed-TASK-001",
    requiredCapabilities: ["dispatch"],
    hostId: "laptop",
    decision: {},
    lease: {
      leaseId: "lease-1",
      hostId: "laptop",
      acquiredAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
    ...overrides,
  };
  await saveFederatedJob(projectRoot, record);
  return record;
}

function parseErrorBody(body: string): { error?: string; code?: string; hint?: string } {
  return JSON.parse(body) as { error?: string; code?: string; hint?: string };
}

it("accepts an assigned job held only by the configured headnode", async () => {
  const workerRoot = makeTempDir();
  const headRoot = makeTempDir();
  fs.mkdirSync(path.join(workerRoot, "docs", "tasks"), { recursive: true });
  writeListener(workerRoot);
  const record = await writeFederatedClaim(headRoot, { projectId: "remote-fixture", taskId: "TASK-GHOST" });
  let requests = 0;
  const peer = http.createServer((_req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, job: record }));
  });
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("missing peer port");
  fs.writeFileSync(path.join(workerRoot, ".quack", "federation", "peer.json"), JSON.stringify({
    url: `http://127.0.0.1:${address.port}`, remoteProjectId: "remote-fixture",
    serviceToken: "fixture-token", startAuthority: { hostId: "laptop" }, syncOnStartup: false,
  }));
  const monitor = createMonitorServer({ port: 0, host: "127.0.0.1", projectRoot: workerRoot, taskDir: "docs/tasks" });
  const started = await monitor.start();
  try {
    const result = await httpPost(`http://127.0.0.1:${started.port}/api/tasks/TASK-GHOST/start`, {
      federatedJobId: record.jobId, federatedHostId: "laptop", federatedLeaseId: "lease-1",
    });
    console.log(JSON.stringify({ workerStatus: result.status, body: result.body, authorityRequests: requests,
      localJobExists: fs.existsSync(path.join(workerRoot, ".quack", "federation", "jobs", `${record.jobId}.json`)) }));
    expect(result.status).toBe(404);
    expect(parseErrorBody(result.body).error).toBe("Task TASK-GHOST not found");
    expect(requests).toBe(1);
  } finally {
    await started.stop();
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) => peer.close((err) => err ? reject(err) : resolve()));
    removeTempDir(workerRoot);
    removeTempDir(headRoot);
  }
});

describe("remote authority at route mutation fences", () => {
  let workerRoot: string;
  let headRoot: string;
  let baseUrl: string;
  let stop: () => Promise<void>;
  let peer: http.Server;
  let job: FederatedJobRecord;
  let reads: number;
  let peerUnavailable: boolean;
  let afterFirstRead: ((res: http.ServerResponse, text: string) => Promise<void>) | undefined;
  let startSpy: jest.SpiedFunction<DispatchManager["start"]>;
  const body = { skipGate: true, federatedJobId: "fed-TASK-001",
    federatedHostId: "laptop", federatedLeaseId: "lease-1" };
  beforeEach(async () => {
    workerRoot = makeTempDir();
    headRoot = makeTempDir();
    fs.mkdirSync(path.join(workerRoot, "docs/tasks"), { recursive: true });
    fs.mkdirSync(path.join(workerRoot, ".quack/logs"), { recursive: true });
    writeTask(workerRoot);
    writeListener(workerRoot);
    job = await writeFederatedClaim(headRoot, { projectId: "remote-fixture" });
    reads = 0;
    peerUnavailable = false;
    afterFirstRead = undefined;
    peer = http.createServer((_req, res) => {
      reads += 1;
      if (peerUnavailable) { res.destroy(); return; }
      const current: unknown = JSON.parse(fs.readFileSync(path.join(headRoot,
        ".quack/federation/jobs", `${job.jobId}.json`), "utf8"));
      const text = JSON.stringify({ ok: true, job: current });
      if (reads === 1 && afterFirstRead) {
        void afterFirstRead(res, text).catch(() => res.destroy());
      } else {
        res.end(text);
      }
    });
    await new Promise<void>((done) => peer.listen(0, "127.0.0.1", done));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    fs.writeFileSync(path.join(workerRoot, ".quack/federation/peer.json"), JSON.stringify({
      url: `http://127.0.0.1:${address.port}`, remoteProjectId: "remote-fixture",
      serviceToken: "fixture-token", startAuthority: { hostId: "laptop" }, syncOnStartup: false,
    }));
    startSpy = jest.spyOn(DispatchManager.prototype, "start").mockReturnValue({
      taskId: "TASK-001", sessionId: "fixture-session", pid: 0,
      startedAt: new Date().toISOString(), status: "running", output: [],
    });
    const monitor = createMonitorServer({ port: 0, host: "127.0.0.1", projectRoot: workerRoot,
      taskDir: "docs/tasks", logDir: path.join(workerRoot, ".quack/logs") });
    const started = await monitor.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
  });
  afterEach(async () => {
    await stop();
    startSpy.mockRestore();
    peer.closeAllConnections();
    await new Promise<void>((done, reject) => peer.close((error) => error ? reject(error) : done()));
    removeTempDir(workerRoot);
    removeTempDir(headRoot);
  });
  function priorRun(): void {
    fs.writeFileSync(path.join(workerRoot, ".quack/logs/sessions.jsonl"), JSON.stringify({
      taskId: "TASK-001", sessionId: "previous", project: "fixture", status: "completed",
      outcome: "rejected", startTime: "2026-01-01T00:00:00.000Z",
    }) + "\n");
  }

  it.each(["start", "revise"])("verifies remote authority twice before %s", async (route) => {
    if (route === "revise") priorRun();
    const response = await httpPost(`${baseUrl}/api/tasks/TASK-001/${route}`, { ...body, feedback: "fix" });
    expect(response.status).toBe(200);
    expect(reads).toBe(2);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]?.[1]?.provenance?.channel).toBe("listener-execution");
    expect(fs.existsSync(path.join(workerRoot, ".quack/federation/jobs", `${job.jobId}.json`))).toBe(false);
  });
  it.each(["start", "revise"])("rejects reassignment while %s waits at the final fence", async (route) => {
    if (route === "revise") priorRun();
    const sessionsPath = path.join(workerRoot, ".quack/logs/sessions.jsonl");
    const before = fs.existsSync(sessionsPath) ? fs.readFileSync(sessionsPath, "utf8") : undefined;
    let release!: () => void;
    let captured = false;
    const held = new Promise<void>((done) => { release = done; });
    // Earlier task lookup also takes this reservation. Acquire only once the
    // first authority request arrives, then hold it across that valid response.
    afterFirstRead = (res, text) => withTaskCreationReservation(path.join(workerRoot, "docs/tasks"),
      { creator: "dispatch-admission", requestedIds: [] }, async () => {
        res.end(text);
        captured = true;
        await held;
      });
    const response = httpPost(`${baseUrl}/api/tasks/TASK-001/${route}`, { ...body, feedback: "fix" });
    try {
      const deadline = Date.now() + 3_000;
      while (!captured && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(captured).toBe(true);
      expect(reads).toBe(1);
      await saveFederatedJob(headRoot, { ...job, lease: { ...job.lease!, leaseId: "new-lease" } });
    } finally {
      release();
      // Drain the request before afterEach can close its database, even when
      // an assertion fails while the request is held at the reservation.
      await response;
    }
    const result = await response;
    expect(result.status).toBe(409);
    expect(parseErrorBody(result.body).code).toBe("federated_claim_unverified");
    expect(reads).toBe(2);
    expect(startSpy).not.toHaveBeenCalled();
    if (before !== undefined) expect(fs.readFileSync(sessionsPath, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(workerRoot, ".quack/logs/checkpoint-TASK-001.json"))).toBe(false);
  });
  it.each(["invalid config", "wrong project", "peer offline"])("refuses %s without a local listener registry", async (failure) => {
    fs.unlinkSync(path.join(workerRoot, ".quack/federation/listeners/laptop.json"));
    if (failure === "invalid config") {
      fs.writeFileSync(path.join(workerRoot, ".quack/federation/peer.json"), "private-invalid-json");
    } else if (failure === "wrong project") {
      await saveFederatedJob(headRoot, { ...job, projectId: "wrong-default-project" });
    } else {
      peerUnavailable = true;
    }
    const warnings = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const taskId = failure === "invalid config" ? "TASK-GHOST" : "TASK-001";
      const response = await httpPost(`${baseUrl}/api/tasks/${taskId}/start`, {
        ...body, federatedHostEndpoint: "http://untrusted.invalid", federatedRecord: job,
      });
      expect(response.status).toBe(409);
      expect(parseErrorBody(response.body).code).toBe("federated_claim_unverified");
      expect(parseErrorBody(response.body).hint).toContain("headnode availability");
      const logs = JSON.stringify(warnings.mock.calls);
      const reason = failure === "invalid config" ? "config_invalid" :
        failure === "wrong project" ? "claim_mismatch" : "peer_unreachable";
      expect(warnings.mock.calls.some(([value]) => typeof value === "string" &&
        value.includes(`"reason":"${reason}"`))).toBe(true);
      for (const sensitive of ["private-invalid-json", "fixture-token"]) {
        expect(logs).not.toContain(sensitive);
        expect(response.body).not.toContain(sensitive);
      }
      expect(startSpy).not.toHaveBeenCalled();
    } finally { warnings.mockRestore(); }
  });
  it("localSmokeOnly does not excuse an invalid asserted federated claim", async () => {
    const response = await httpPost(`${baseUrl}/api/tasks/TASK-GHOST/start`, {
      localSmokeOnly: true, federatedJobId: job.jobId, federatedHostId: "laptop",
    });
    expect(response.status).toBe(409);
    expect(parseErrorBody(response.body).code).toBe("federated_claim_unverified");
    expect(startSpy).not.toHaveBeenCalled();
  });
});
