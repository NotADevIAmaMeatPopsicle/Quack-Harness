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
        users: [
          {
            username: "admin",
            passwordHash: "unused",
            role: "admin",
          },
        ],
        serviceTokens: [
          {
            id: "worker-admin",
            tokenHash: sha256("worker-admin-token"),
            scopes: ["listener:admin"],
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

async function httpPost(
  url: string,
  data: Record<string, unknown>,
  serviceToken?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    };
    if (serviceToken) {
      headers["X-Quack-Service-Token"] = serviceToken;
    }
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

describe("worker refresh service-token auth", () => {
  let projectRoot: string;
  let quackRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    projectRoot = makeTempDir("quack-worker-refresh-project-");
    quackRoot = makeTempDir("quack-worker-refresh-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    removeTempDir(projectRoot);
    removeTempDir(quackRoot);
  });

  it("allows scoped service tokens through dashboard auth for /api/workers refresh", async () => {
    const serverObj = createMonitorServer({
      projectRoot,
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port: 0,
      host: "127.0.0.1",
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;

    const response = await httpPost(
      `http://127.0.0.1:${port}/api/workers/headnode/refresh`,
      {
        dryRun: true,
        reason: "regression-test",
        repos: ["example-service"],
      },
      "worker-admin-token",
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      hostId: "headnode",
      dryRun: true,
    });
  });
});
