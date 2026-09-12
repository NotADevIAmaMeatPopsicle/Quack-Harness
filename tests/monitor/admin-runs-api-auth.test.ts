import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeAuthConfig(quackRoot: string): void {
  const authDir = path.join(quackRoot, ".quack");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(authDir, "auth.json"),
    JSON.stringify(
      {
        users: [],
        serviceTokens: [
          {
            id: "federation-admin",
            tokenHash: sha256("fed-token"),
            scopes: ["federation:write"],
            enabled: true,
          },
          {
            id: "admin-read",
            tokenHash: sha256("admin-read-token"),
            scopes: ["admin:read"],
            enabled: true,
          },
          {
            id: "admin-write",
            tokenHash: sha256("admin-write-token"),
            scopes: ["admin:write"],
            enabled: true,
          },
          {
            id: "listener-read",
            tokenHash: sha256("listener-read-token"),
            scopes: ["listener:read"],
            enabled: true,
          },
        ],
        sessionSecret: "test",
        sessionTtlMs: 86400000,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function httpGet(
  url: string,
  serviceToken?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "GET",
        headers: serviceToken ? { "X-Quack-Service-Token": serviceToken } : undefined,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function httpPost(
  url: string,
  body: unknown,
  serviceToken?: string,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(serviceToken ? { "X-Quack-Service-Token": serviceToken } : {}),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("admin run read auth", () => {
  let logDir: string;
  let quackRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir("quack-admin-runs-log-");
    quackRoot = makeTempDir("quack-admin-runs-root-");
    writeAuthConfig(quackRoot);
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    removeTempDir(logDir);
    removeTempDir(quackRoot);
  });

  async function startServer(): Promise<number> {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      quackRoot,
    });
    const started = await serverObj.start();
    stopServer = started.stop;
    return started.port;
  }

  it("allows federation:write tokens to list admin runs", async () => {
    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/admin/runs`, "fed-token");

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ runs: [] });
  });

  it("allows admin-scoped tokens to read admin run status endpoints", async () => {
    const port = await startServer();

    const readResult = await httpGet(`http://127.0.0.1:${port}/api/admin/runs`, "admin-read-token");
    expect(readResult.status).toBe(200);
    expect(JSON.parse(readResult.body)).toEqual({ runs: [] });

    const writeResult = await httpGet(
      `http://127.0.0.1:${port}/api/admin/runs/missing`,
      "admin-write-token",
    );
    expect(writeResult.status).toBe(404);
    expect(JSON.parse(writeResult.body)).toEqual({ error: "Admin run not found" });
  });

  it("rejects tokens without trusted admin-read scopes", async () => {
    const port = await startServer();

    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/api/admin/runs`,
      "listener-read-token",
    );

    expect(status).toBe(403);
    expect(JSON.parse(body)).toEqual({
      error: "service_token_scope_denied",
      message: "Service token listener-read lacks required scope admin:read.",
      requiredScopes: ["admin:read", "admin:write", "federation:write"],
    });
  });

  it("enforces read/write scopes on the drain API without mutating state on rejection", async () => {
    const port = await startServer();
    const baseUrl = `http://127.0.0.1:${port}/api/admin/drain`;

    const missingRead = await httpGet(baseUrl);
    expect(missingRead.status).toBe(401);

    const wrongRead = await httpGet(baseUrl, "listener-read-token");
    expect(wrongRead.status).toBe(403);

    const initial = await httpGet(baseUrl, "admin-read-token");
    expect(initial.status).toBe(200);
    expect(JSON.parse(initial.body)).toMatchObject({ active: false, acceptingWork: true });

    const missingWrite = await httpPost(baseUrl, { reason: "must not apply" });
    expect(missingWrite.status).toBe(401);

    const readOnlyWrite = await httpPost(baseUrl, { reason: "must not apply" }, "admin-read-token");
    expect(readOnlyWrite.status).toBe(403);

    const afterRejectedWrites = await httpGet(baseUrl, "admin-read-token");
    expect(afterRejectedWrites.status).toBe(200);
    expect(JSON.parse(afterRejectedWrites.body)).toMatchObject({
      active: false,
      acceptingWork: true,
    });

    const accepted = await httpPost(
      baseUrl,
      { reason: "authorized test drain" },
      "admin-write-token",
    );
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({
      active: true,
      acceptingWork: false,
      safeToTerminate: true,
      state: { reason: "authorized test drain" },
    });
  });
});
