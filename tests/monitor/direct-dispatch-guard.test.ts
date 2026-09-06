import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

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

function parseErrorBody(body: string): { error?: string; code?: string } {
  return JSON.parse(body) as { error?: string; code?: string };
}

describe("direct dispatch guard", () => {
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
    writeListener(projectRoot);
    writeTask(projectRoot);
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    removeTempDir(projectRoot);
  });

  async function startServer(): Promise<string> {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      port,
      projectRoot,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
    return `http://localhost:${port}`;
  }

  it("blocks direct starts when a federated listener is registered", async () => {
    const baseUrl = await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-999/start`, {
      skipGate: true,
    });

    expect(status).toBe(409);
    expect(parseErrorBody(body)).toMatchObject({
      code: "direct_dispatch_blocked_in_swarm_mode",
    });
  });

  it("lets explicit local smoke requests reach normal task validation", async () => {
    const baseUrl = await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-999/start`, {
      skipGate: true,
      localSmokeOnly: true,
    });

    expect(status).toBe(404);
    expect(parseErrorBody(body).error).toContain("not found");
  });

  // TASK-1323 round-2 F1 changed this contract and these two tests were
  // left encoding the old one: a federated claim is no longer believed
  // because it was ASSERTED. `verifyFederatedStartClaim` checks the
  // store (the job exists, is bound to that host, and is active), so an
  // unverifiable claim draws its own 409 instead of sailing past the
  // swarm block into task validation. Restored to the shipped contract
  // rather than deleted: the claim path still has to be exercised.
  it("refuses a federated start whose claim cannot be verified", async () => {
    const baseUrl = await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-999/start`, {
      skipGate: true,
      federatedJobId: "fed-TASK-999",
      federatedHostId: "laptop",
    });

    expect(status).toBe(409);
    expect(parseErrorBody(body)).toMatchObject({
      code: "federated_claim_unverified",
    });
  });

  it("blocks direct revision starts when a federated listener is registered", async () => {
    const baseUrl = await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-001/revise`, {
      feedback: "retry",
    });

    expect(status).toBe(409);
    expect(parseErrorBody(body)).toMatchObject({
      code: "direct_revision_blocked_in_swarm_mode",
    });
  });

  it("refuses a federated revision whose claim cannot be verified", async () => {
    const baseUrl = await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-001/revise`, {
      feedback: "retry",
      federatedJobId: "fix-TASK-001",
      federatedHostId: "laptop",
    });

    expect(status).toBe(409);
    expect(parseErrorBody(body)).toMatchObject({
      code: "federated_claim_unverified",
    });
  });
});
