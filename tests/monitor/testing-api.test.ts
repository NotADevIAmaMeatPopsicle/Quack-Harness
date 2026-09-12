import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";
import type { TestRunResult } from "../../src/core/types";
import { loadAdapter } from "../../src/core/adapter-loader";

// Prevent tests from picking up real .quack/auth.json (which has users → auth enabled)
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-testing-"));
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the test runner reports the expected running state. */
async function waitForRunningState(
  port: number,
  running: boolean,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpGet(`http://127.0.0.1:${port}/api/testing/status`);
    const st = JSON.parse(res.body) as { running: boolean };
    if (st.running === running) return;
    await sleep(200);
  }
}

// ─── Shared adapter fixture builder ──────────────────────────────
// Produces a valid adapter.json matching AdapterConfigSchema.
// Only the verification.commands field varies between tests.

interface CommandOverride {
  name: string;
  command: string;
  required: boolean;
  timeout: number;
}

function buildAdapterConfig(
  commands: CommandOverride[],
  projectName = "test-project",
): Record<string, unknown> {
  return {
    version: "1.0",
    project: {
      name: projectName,
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-sonnet-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands,
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/", "tests/"],
      deniedPaths: [".env"],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    },
    logging: {
      dir: ".quack/logs",
      level: "debug",
      retainDays: 30,
    },
  };
}

const FAST_COMMANDS: CommandOverride[] = [
  { name: "test", command: "echo test-passed", required: true, timeout: 10000 },
  { name: "lint", command: "echo lint-passed", required: false, timeout: 10000 },
  { name: "build", command: "echo build-passed", required: true, timeout: 10000 },
];

// Cross-platform slow command — deterministic, no platform branching
const SLOW_CMD_3S = 'node -e "setTimeout(()=>{},3000)"';
const SLOW_CMD_10S = 'node -e "setTimeout(()=>{},10000)"';

// ─── Tests ───────────────────────────────────────────────────────

describe("Testing API", () => {
  let logDir: string;
  let projectRoot: string;
  let adapterPath: string;
  let stopServer: (() => Promise<void>) | undefined;
  let port: number;

  beforeAll(async () => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();

    // Create .quack dir and adapter.json with verification commands
    const quackDir = path.join(projectRoot, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    adapterPath = path.join(quackDir, "adapter.json");

    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(FAST_COMMANDS), null, 2),
      "utf-8",
    );

    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      adapterPath,
      projectRoot,
    });
    ({ port, stop: stopServer } = await serverObj.start());
  });

  afterAll(async () => {
    if (stopServer) await stopServer();
    // Wait for child processes to fully exit before cleanup
    await sleep(500);
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* EBUSY on Windows */
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* EBUSY on Windows */
    }
  });

  // ─── GET /api/testing/commands ────────────────────────────

  it("returns verification commands from adapter.json", async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/testing/commands`);
    expect(status).toBe(200);

    const commands = JSON.parse(body) as Array<{
      name: string;
      command: string;
      required: boolean;
      timeout: number;
    }>;
    expect(commands).toHaveLength(3);
    expect(commands[0].name).toBe("test");
    expect(commands[0].required).toBe(true);
    expect(commands[0].timeout).toBe(10000);
    expect(commands[1].name).toBe("lint");
    expect(commands[2].name).toBe("build");
  });

  it("returns empty array for malformed adapter commands", async () => {
    // Write adapter with commands missing required fields (no `required`, no `timeout`)
    const malformed = {
      ...buildAdapterConfig(FAST_COMMANDS),
      verification: {
        commands: [
          { name: "test", command: "echo test" }, // missing required + timeout
        ],
        conventionChecks: [],
      },
    };
    fs.writeFileSync(adapterPath, JSON.stringify(malformed, null, 2), "utf-8");

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/testing/commands`);
    expect(status).toBe(200);

    const commands = JSON.parse(body) as unknown[];
    expect(commands).toEqual([]);

    // Restore valid config
    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(FAST_COMMANDS), null, 2),
      "utf-8",
    );
  });

  // ─── POST /api/testing/run ────────────────────────────────

  it("starts a command and returns ok", async () => {
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "test",
    });
    expect(status).toBe(200);

    const data = JSON.parse(body) as {
      ok: boolean;
      name: string;
      adapterFreshness?: { status: string; localHash?: string; authoritativeHash?: string };
    };
    expect(data.ok).toBe(true);
    expect(data.name).toBe("test");
    expect(data.adapterFreshness?.status).toBe("fresh");
    expect(data.adapterFreshness?.localHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(data.adapterFreshness?.authoritativeHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Wait for the echo command to finish
    await waitForRunningState(port, false);

    const historyResp = await httpGet(`http://127.0.0.1:${port}/api/testing/history`);
    const history = JSON.parse(historyResp.body) as TestRunResult[];
    expect(history.at(-1)?.adapterFreshness).toMatchObject({
      status: "fresh",
      localHash: data.adapterFreshness?.localHash,
      authoritativeHash: data.adapterFreshness?.authoritativeHash,
    });
  });

  it("routes non-direct verification through the configured sandbox instead of the host", async () => {
    const sentinel = path.join(projectRoot, "host-execution-sentinel.txt");
    const maliciousCommand = `node -e "require('node:fs').writeFileSync('${sentinel.replace(/\\/g, "/")}', 'unsafe')"`;
    const config = buildAdapterConfig([
      { name: "test", command: maliciousCommand, required: true, timeout: 10000 },
    ]);
    const verification = config.verification as Record<string, unknown>;
    verification.hostExecution = "codex-sandbox";
    const agent = config.agent as Record<string, unknown>;
    agent.runner = "codex-cli";
    agent.codex = {
      binaryPath: path.join(projectRoot, "missing-codex-executable"),
      sandbox: "workspace-write",
    };
    // An unavailable sandbox executable must fail closed before the command
    // can touch the monitor host.
    fs.writeFileSync(adapterPath, JSON.stringify(config, null, 2), "utf-8");

    const { status } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "test",
    });
    expect(status).toBe(200);
    await waitForRunningState(port, false);

    expect(fs.existsSync(sentinel)).toBe(false);
    const historyResp = await httpGet(`http://127.0.0.1:${port}/api/testing/history`);
    const history = JSON.parse(historyResp.body) as TestRunResult[];
    expect(history.at(-1)?.command).toBe("verification:test");
    expect(history.at(-1)?.exitCode).toBe(1);

    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(FAST_COMMANDS), null, 2),
      "utf-8",
    );
  });

  it("returns 400 when command is missing", async () => {
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {});
    expect(status).toBe(400);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("Missing");
  });

  it("returns 400 for unknown command name", async () => {
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "nonexistent",
    });
    expect(status).toBe(400);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("Unknown command");
  });

  it("returns 409 when a command is already running", async () => {
    // Swap in slow command
    const slowCommands: CommandOverride[] = [
      { name: "test", command: SLOW_CMD_3S, required: true, timeout: 10000 },
      { name: "lint", command: "echo lint-passed", required: false, timeout: 10000 },
      { name: "build", command: "echo build-passed", required: true, timeout: 10000 },
    ];
    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(slowCommands), null, 2),
      "utf-8",
    );

    const { status: startStatus } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "test",
    });
    expect(startStatus).toBe(200);

    // Wait until the runner reports running before sending the second request
    await waitForRunningState(port, true);

    // Try to start another while first is running
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "lint",
    });
    expect(status).toBe(409);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("already running");

    // Stop the running command and wait for it to finish
    await httpPost(`http://127.0.0.1:${port}/api/testing/stop`);
    await waitForRunningState(port, false);

    // Restore fast commands
    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(FAST_COMMANDS), null, 2),
      "utf-8",
    );
  }, 15000);

  // ─── GET /api/testing/status ──────────────────────────────

  it("returns running state with name and command", async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/testing/status`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { running: boolean; name: string; command: string };
    expect(typeof data.running).toBe("boolean");
    expect(typeof data.name).toBe("string");
    expect(typeof data.command).toBe("string");
  });

  // ─── POST /api/testing/stop ───────────────────────────────

  it("stops a running command", async () => {
    // Swap in slow command
    const slowCommands: CommandOverride[] = [
      { name: "test", command: SLOW_CMD_10S, required: true, timeout: 30000 },
      { name: "lint", command: "echo lint-passed", required: false, timeout: 10000 },
      { name: "build", command: "echo build-passed", required: true, timeout: 10000 },
    ];
    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(slowCommands), null, 2),
      "utf-8",
    );

    await httpPost(`http://127.0.0.1:${port}/api/testing/run`, { command: "test" });
    await waitForRunningState(port, true);

    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/stop`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { ok: boolean };
    expect(data.ok).toBe(true);

    await waitForRunningState(port, false);

    // Restore fast commands
    fs.writeFileSync(
      adapterPath,
      JSON.stringify(buildAdapterConfig(FAST_COMMANDS), null, 2),
      "utf-8",
    );
  }, 15000);

  it("returns 404 when nothing is running", async () => {
    // Ensure nothing is running
    await waitForRunningState(port, false);

    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/stop`);
    expect(status).toBe(404);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("No command");
  });

  // ─── GET /api/testing/history ─────────────────────────────

  it("returns completed run results with exitCode and durationMs", async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/testing/history`);
    expect(status).toBe(200);

    const history = JSON.parse(body) as TestRunResult[];
    expect(Array.isArray(history)).toBe(true);
    // Should have results from earlier tests
    expect(history.length).toBeGreaterThan(0);
    // Verify shape of first result
    const first = history[0];
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("command");
    expect(first).toHaveProperty("exitCode");
    expect(first).toHaveProperty("durationMs");
  });

  // ─── GET /api/testing/stream ──────────────────────────────

  it("returns SSE headers (Content-Type: text/event-stream)", async () => {
    const { status } = await new Promise<{ status: number; body: string }>((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/testing/stream`, (res) => {
        // Just check the headers and close
        resolve({ status: res.statusCode ?? 0, body: "" });
        res.destroy();
      });
    });

    expect(status).toBe(200);
  });
});

describe("Testing API project isolation", () => {
  let rootAlpha: string;
  let rootBeta: string;
  let stopServer: (() => Promise<void>) | undefined;
  let port: number;

  beforeAll(async () => {
    rootAlpha = makeTempDir();
    rootBeta = makeTempDir();
    for (const [root, name] of [
      [rootAlpha, "scope-alpha"],
      [rootBeta, "scope-beta"],
    ] as const) {
      fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
      fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
      const command = `node -e "require('node:fs').writeFileSync('selected-project.txt', '${name}')"`;
      fs.writeFileSync(
        path.join(root, ".quack", "adapter.json"),
        JSON.stringify(
          buildAdapterConfig([{ name: "test", command, required: true, timeout: 10_000 }], name),
          null,
          2,
        ),
      );
    }
    const adapters = await Promise.all([loadAdapter(rootAlpha), loadAdapter(rootBeta)]);
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: adapters,
    });
    ({ port, stop: stopServer } = await server.start());
  });

  afterAll(async () => {
    if (stopServer) await stopServer();
    for (const root of [rootAlpha, rootBeta]) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may retain a short-lived file handle after process exit.
      }
    }
  });

  it("runs a selected project's command only in that project's root", async () => {
    const { status } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "test",
      projectId: "scope-beta",
    });
    expect(status).toBe(200);

    const marker = path.join(rootBeta, "selected-project.txt");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await sleep(100);
    }
    expect(fs.readFileSync(marker, "utf8")).toBe("scope-beta");
    expect(fs.existsSync(path.join(rootAlpha, "selected-project.txt"))).toBe(false);

    const betaHistory = await httpGet(
      `http://127.0.0.1:${port}/api/testing/history?project=scope-beta`,
    );
    const alphaHistory = await httpGet(
      `http://127.0.0.1:${port}/api/testing/history?project=scope-alpha`,
    );
    expect((JSON.parse(betaHistory.body) as TestRunResult[]).at(-1)?.projectId).toBe(rootBeta);
    expect(JSON.parse(alphaHistory.body)).toEqual([]);
  });
});

describe("Tier 3 drain tracking", () => {
  let projectRoot: string;
  let logDir: string;
  let stopServer: (() => Promise<void>) | undefined;
  let port: number;

  beforeAll(async () => {
    projectRoot = makeTempDir();
    logDir = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
    const config = buildAdapterConfig(
      [
        {
          name: "full-suite",
          command: 'node -e "setTimeout(() => {}, 2000)"',
          required: true,
          timeout: 10_000,
        },
      ],
      "drain-project",
    );
    const verification = config.verification as Record<string, unknown>;
    verification.tieredTesting = { enabled: true };
    const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
    fs.writeFileSync(adapterPath, JSON.stringify(config, null, 2));
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectRoot,
      adapterPath,
      logDir,
    });
    ({ port, stop: stopServer } = await server.start());
  });

  afterAll(async () => {
    if (stopServer) await stopServer();
    for (const root of [projectRoot, logDir]) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may retain a short-lived file handle after process exit.
      }
    }
  });

  it("keeps drain unsafe until the tracked full-suite verifier exits", async () => {
    const started = await httpPost(`http://127.0.0.1:${port}/api/test/full-suite`);
    expect(started.status).toBe(200);

    const draining = await httpPost(`http://127.0.0.1:${port}/api/admin/drain`, {
      reason: "test",
    });
    expect(draining.status).toBe(202);
    expect(JSON.parse(draining.body)).toMatchObject({
      active: true,
      acceptingWork: false,
      safeToTerminate: false,
      testRunActive: true,
    });

    await sleep(2500);
    const settled = await httpGet(`http://127.0.0.1:${port}/api/admin/drain`);
    expect(settled.status).toBe(200);
    expect(JSON.parse(settled.body)).toMatchObject({
      active: true,
      acceptingWork: false,
      safeToTerminate: true,
      testRunActive: false,
    });
  }, 15_000);
});

// ─── Server without project root ────────────────────────────────

describe("Testing API without project root", () => {
  let logDir: string;
  let stopServer: (() => Promise<void>) | undefined;
  let port: number;

  beforeAll(async () => {
    logDir = makeTempDir();
    const serverObj = createMonitorServer({ logDir, port: 0, host: "127.0.0.1" });
    ({ port, stop: stopServer } = await serverObj.start());
  });

  afterAll(async () => {
    if (stopServer) await stopServer();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("POST /api/testing/run returns 500 when projectRoot is not configured", async () => {
    const { status, body } = await httpPost(`http://127.0.0.1:${port}/api/testing/run`, {
      command: "test",
    });
    expect(status).toBe(500);

    const data = JSON.parse(body) as { error: string };
    expect(data.error).toContain("project root");
  });

  it("GET /api/testing/commands returns empty array when no adapter configured", async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/testing/commands`);
    expect(status).toBe(200);

    const commands = JSON.parse(body) as unknown[];
    expect(commands).toEqual([]);
  });
});

// ─── Dashboard tab button ───────────────────────────────────────

describe("Testing tab in dashboard HTML", () => {
  it("Testing tab button appears in dashboard navigation", () => {
    const htmlPath = path.join(__dirname, "..", "..", "src", "monitor", "public", "index.html");
    const html = fs.readFileSync(htmlPath, "utf-8");
    expect(html).toContain("switchTab('testing')");
    expect(html).toContain(">Testing<");
    expect(html).toContain('id="tab-testing"');
  });
});
