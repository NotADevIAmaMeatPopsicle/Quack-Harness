import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createMonitorServer } from "../../src/monitor/server";
import { SSEManager } from "../../src/monitor/sse-manager";
import { ClaudeAuthHealthProbe } from "../../src/sdk/claude-auth-health";
import * as trustedNode from "../../src/monitor/trusted-node-launch";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

interface Response {
  status: number;
  body: Record<string, unknown>;
}
function request(port: number, route: string, method = "GET"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(body) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
class FakeChild extends EventEmitter {
  pid = 54545;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe("operator prep and authentication diagnostics", () => {
  const originalEnvironment = process.env;
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let child: FakeChild;
  beforeEach(() => {
    process.env = { ...originalEnvironment };
    for (const name of Object.keys(process.env))
      if (/^(?:ANTHROPIC_API_KEY(?:_\d+)?|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name))
        delete process.env[name];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-api-"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../fixtures/task-valid-minimal.md"),
      path.join(root, "docs", "tasks", "TASK-001.md"),
    );
    child = new FakeChild();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (stop) await stop();
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      stop = undefined;
      process.env = originalEnvironment;
    }
  });
  async function start(): Promise<number> {
    const server = createMonitorServer({
      projectRoot: root,
      taskDir: "docs/tasks",
      logDir: path.join(root, ".quack", "logs"),
      host: "127.0.0.1",
      port: 0,
    });
    const started = await server.start();
    stop = started.stop;
    return started.port;
  }

  it("returns the closed failed job after cache 404 and after a monitor restart", async () => {
    const broadcast = jest.spyOn(SSEManager.prototype, "broadcast");
    jest.spyOn(trustedNode, "spawnTrustedNode").mockImplementation((options) => {
      if (options.args[0] !== "prep")
        throw new Error("Unexpected child launch in prep diagnostic fixture");
      return {
        child: child as unknown as ChildProcess,
        executablePath: process.execPath,
        processId: child.pid,
      };
    });
    let port = await start();
    expect((await request(port, "/api/tasks/TASK-001/prep", "POST")).status).toBe(200);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ error: "fixture provider refused" })));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect((await request(port, "/api/tasks/TASK-001/prep/job")).body.job).toMatchObject({
      status: "running",
    });
    child.emit("close", 0, null);
    const response = await request(port, "/api/tasks/TASK-001/prep/job");
    expect(response).toMatchObject({
      status: 200,
      body: {
        job: {
          status: "failed",
          exitCode: 0,
          signal: null,
          completedAt: expect.any(String) as unknown,
          error: expect.stringContaining("fixture provider refused") as unknown,
        },
      },
    });
    const missing = await request(port, "/api/tasks/TASK-001/prep");
    expect(missing).toMatchObject({ status: 404, body: { job: { status: "failed" } } });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "prep_failed",
        taskId: "TASK-001",
        payload: expect.objectContaining({
          exitCode: 0,
          completedAt: expect.any(String) as unknown,
        }) as unknown,
      }),
    );
    await stop!();
    stop = undefined;
    port = await start();
    expect((await request(port, "/api/tasks/TASK-001/prep/job")).body.job).toEqual(
      response.body.job,
    );
  });

  it("reports auth conflict in health without deleting parent credentials or probing on GET", async () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-api",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
      CLAUDECODE: "fixture-parent-session",
    });
    const probe = jest
      .spyOn(ClaudeAuthHealthProbe.prototype, "probe")
      .mockRejectedValue(new Error("GET must not perform provider work"));
    const port = await start();
    for (let index = 0; index < 3; index++) {
      const response = await request(port, "/api/health");
      expect(response).toMatchObject({
        status: 200,
        body: {
          status: "degraded",
          claudeAuth: {
            configuration: { mode: "conflict" },
            probe: { status: "unprobed" },
            ready: false,
          },
        },
      });
    }
    expect(probe).not.toHaveBeenCalled();
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-api");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-oauth");
    expect(process.env.CLAUDECODE).toBe("fixture-parent-session");
  });

  it("reports a corrupt persisted job explicitly without rewriting it", async () => {
    const directory = path.join(root, ".quack", "logs", "prep-jobs");
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `${Buffer.from("TASK-001").toString("base64url")}.json`);
    fs.writeFileSync(filename, "null", "utf8");
    const port = await start();
    expect((await request(port, "/api/tasks/TASK-001/prep/job")).status).toBe(503);
    expect(fs.readFileSync(filename, "utf8")).toBe("null");
    expect((await request(port, "/api/tasks/TASK-999/prep/job")).status).toBe(404);
  });
});
