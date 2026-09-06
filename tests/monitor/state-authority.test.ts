import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

interface HttpResult {
  status: number;
  body: string;
}

interface AuthorityResponse {
  runtimeRole: string;
  stateAuthority: string;
  canonicalBaseUrl: string | null;
  localDbAuthoritative: boolean;
}

interface ProjectSummary extends AuthorityResponse {
  id: string;
}

interface TestingStatusResponse {
  running: boolean;
  authority: AuthorityResponse;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-state-authority-"));
}

function makeProjectRoot(): string {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, ".quack"), { recursive: true });
  return dir;
}

function makeUiBuildDir(): string {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>test</title>", "utf-8");
  return dir;
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

function request(method: string, url: string, body?: unknown): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("monitor state authority", () => {
  let stopServer: (() => Promise<void>) | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    for (const tempDir of tempDirs.splice(0)) removeTempDir(tempDir);
  });

  it("reports canonical authority from headnode health", async () => {
    const logDir = makeTempDir();
    const quackRoot = makeTempDir();
    const uiBuildDir = makeUiBuildDir();
    tempDirs.push(logDir, quackRoot, uiBuildDir);
    const port = randomPort();
    const server = createMonitorServer({ logDir, quackRoot, uiBuildDir, port });
    const started = await server.start();
    stopServer = started.stop;

    const response = await request("GET", `http://localhost:${port}/api/health`);
    const body = JSON.parse(response.body) as AuthorityResponse;

    expect(response.status).toBe(200);
    expect(body.runtimeRole).toBe("headnode");
    expect(body.stateAuthority).toBe("canonical");
    expect(body.localDbAuthoritative).toBe(true);
  });

  it("reports cache authority from worker health and projects", async () => {
    const logDir = makeTempDir();
    const quackRoot = makeTempDir();
    const projectRoot = makeProjectRoot();
    tempDirs.push(logDir, quackRoot, projectRoot);
    const port = randomPort();
    const canonicalBaseUrl = "http://127.0.0.1:3333";
    const server = createMonitorServer({
      logDir,
      quackRoot,
      projectRoot,
      port,
      runtimeRole: "worker",
      canonicalBaseUrl,
    });
    const started = await server.start();
    stopServer = started.stop;

    const health = await request("GET", `http://localhost:${port}/api/health`);
    const healthBody = JSON.parse(health.body) as AuthorityResponse;
    expect(healthBody.runtimeRole).toBe("worker");
    expect(healthBody.stateAuthority).toBe("cache");
    expect(healthBody.localDbAuthoritative).toBe(false);
    expect(healthBody.canonicalBaseUrl).toBe(canonicalBaseUrl);

    const projects = await request("GET", `http://localhost:${port}/api/projects`);
    const projectBody = JSON.parse(projects.body) as ProjectSummary[];
    expect(projectBody[0]).toMatchObject({
      stateAuthority: "cache",
      localDbAuthoritative: false,
      canonicalBaseUrl,
    });
  });

  it("adds non-authoritative metadata to local worker testing status", async () => {
    const logDir = makeTempDir();
    const quackRoot = makeTempDir();
    tempDirs.push(logDir, quackRoot);
    const port = randomPort();
    const canonicalBaseUrl = "http://127.0.0.1:3333";
    const server = createMonitorServer({
      logDir,
      quackRoot,
      port,
      runtimeRole: "worker",
      canonicalBaseUrl,
    });
    const started = await server.start();
    stopServer = started.stop;

    const response = await request("GET", `http://localhost:${port}/api/testing/status`);
    const body = JSON.parse(response.body) as TestingStatusResponse;

    expect(response.status).toBe(200);
    expect(body.running).toBe(false);
    expect(body.authority).toMatchObject({
      runtimeRole: "worker",
      stateAuthority: "cache",
      localDbAuthoritative: false,
      canonicalBaseUrl,
    });
  });

  it("rejects worker-mode canonical verified writes without explicit local smoke", async () => {
    const logDir = makeTempDir();
    const quackRoot = makeTempDir();
    const projectRoot = makeProjectRoot();
    tempDirs.push(logDir, quackRoot, projectRoot);
    const port = randomPort();
    const canonicalBaseUrl = "http://127.0.0.1:3333";
    const server = createMonitorServer({
      logDir,
      quackRoot,
      projectRoot,
      port,
      runtimeRole: "worker",
      canonicalBaseUrl,
    });
    const started = await server.start();
    stopServer = started.stop;

    const response = await request("POST", `http://localhost:${port}/api/tasks/TASK-921/verified`, {
      verdict: "VERIFIED",
      commit: "abc123",
      method: "/verify-task",
      criteria_checked: 1,
      criteria_passed: 1,
    });
    const body = JSON.parse(response.body) as AuthorityResponse & {
      error: string;
      correctEndpoint: string;
    };

    expect(response.status).toBe(409);
    expect(body.error).toBe("worker_not_canonical");
    expect(body.stateAuthority).toBe("cache");
    expect(body.localDbAuthoritative).toBe(false);
    expect(body.canonicalBaseUrl).toBe(canonicalBaseUrl);
    expect(body.correctEndpoint).toBe(`${canonicalBaseUrl}/api/tasks/TASK-921/verified`);
  });
});
