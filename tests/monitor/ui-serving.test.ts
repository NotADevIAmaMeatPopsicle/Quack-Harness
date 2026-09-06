import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-ui-serving-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}

describe("Monitor UI serving", () => {
  let logDir: string;
  let tempDirs: string[];
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir();
    tempDirs = [logDir];
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    for (const dir of tempDirs) {
      removeTempDir(dir);
    }
  });

  it("serves UI 2.0 at root and preserves the legacy dashboard at /legacy", async () => {
    const uiBuildDir = makeTempDir();
    tempDirs.push(uiBuildDir);
    fs.mkdirSync(path.join(uiBuildDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(uiBuildDir, "index.html"),
      '<!doctype html><html><body><div id="root">Modern UI Marker</div></body></html>',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(uiBuildDir, "assets", "app.js"),
      "console.log('modern-ui-asset');",
      "utf-8",
    );

    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({ logDir, port, uiBuildDir });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const root = await httpGet(`http://localhost:${port}/`, { Accept: "text/html" });
    expect(root.status).toBe(200);
    expect(root.body).toContain("Modern UI Marker");

    const spaRoute = await httpGet(`http://localhost:${port}/tasks`, { Accept: "text/html" });
    expect(spaRoute.status).toBe(200);
    expect(spaRoute.body).toContain("Modern UI Marker");

    const asset = await httpGet(`http://localhost:${port}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("modern-ui-asset");

    const legacy = await httpGet(`http://localhost:${port}/legacy`, { Accept: "text/html" });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toContain("<title>Quack Monitor</title>");

    const health = await httpGet(`http://localhost:${port}/api/health`);
    expect(health.status).toBe(200);
    const parsed = JSON.parse(health.body) as { uiMode?: string; legacyUiPath?: string };
    expect(parsed.uiMode).toBe("modern");
    expect(parsed.legacyUiPath).toBe("/legacy");
  });

  it("returns 404 for missing asset paths instead of the SPA shell", async () => {
    const uiBuildDir = makeTempDir();
    tempDirs.push(uiBuildDir);
    fs.writeFileSync(
      path.join(uiBuildDir, "index.html"),
      '<!doctype html><html><body><div id="root">Modern UI Marker</div></body></html>',
      "utf-8",
    );

    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({ logDir, port, uiBuildDir });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const missing = await httpGet(`http://localhost:${port}/assets/missing.js`, {
      Accept: "text/javascript",
    });
    expect(missing.status).toBe(404);
  });

  it("falls back to the legacy dashboard when no UI 2.0 build is present", async () => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      logDir,
      port,
      uiBuildDir: path.join(os.tmpdir(), "quack-ui-serving-missing"),
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const root = await httpGet(`http://localhost:${port}/`, { Accept: "text/html" });
    expect(root.status).toBe(200);
    expect(root.body).toContain("<title>Quack Monitor</title>");

    const health = await httpGet(`http://localhost:${port}/api/health`);
    expect(health.status).toBe(200);
    const parsed = JSON.parse(health.body) as { uiMode?: string };
    expect(parsed.uiMode).toBe("legacy");
  });

  it("does not serve UI assets when started in worker runtime mode", async () => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      logDir,
      port,
      runtimeRole: "worker",
      host: "127.0.0.1",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;

    const root = await httpGet(`http://localhost:${port}/`, { Accept: "text/html" });
    expect(root.status).toBe(404);

    const legacy = await httpGet(`http://localhost:${port}/legacy`, { Accept: "text/html" });
    expect(legacy.status).toBe(404);

    const health = await httpGet(`http://localhost:${port}/api/health`);
    expect(health.status).toBe(200);
    const parsed = JSON.parse(health.body) as { uiMode?: string; runtimeRole?: string };
    expect(parsed.uiMode).toBe("headless");
    expect(parsed.runtimeRole).toBe("worker");
  });
});
