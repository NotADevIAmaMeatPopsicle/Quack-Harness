/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

// Prevent tests from picking up real .quack/auth.json
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual("../../src/monitor/auth"),
  initAuthConfig: () => ({
    users: [],
    sessionSecret: "test",
    sessionTtlMs: 86400000,
  }),
}));

// Mock global config to use a temp file instead of ~/.quack/config.json
let tmpHome = "";
function getTestConfigPath(): string {
  return path.join(tmpHome, ".quack", "config.json");
}
jest.mock("../../src/core/global-config", () => {
  const actual = jest.requireActual<typeof import("../../src/core/global-config")>(
    "../../src/core/global-config",
  );
  return {
    ...actual,
    getConfigPath: () => getTestConfigPath(),
    loadGlobalConfig: () => {
      try {
        const raw = fs.readFileSync(getTestConfigPath(), "utf-8");
        const parsed = JSON.parse(raw);
        return {
          projects: parsed.projects ?? [],
          monitor: parsed.monitor ?? { port: 3333 },
          remoteInstances: parsed.remoteInstances ?? [],
        };
      } catch {
        return { projects: [], monitor: { port: 3333 }, remoteInstances: [] };
      }
    },
    saveGlobalConfig: (config: unknown) => {
      const cp = getTestConfigPath();
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, JSON.stringify(config, null, 2), "utf-8");
    },
  };
});

// ─── Helpers ─────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

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

async function httpRequest(
  method: string,
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
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-remotes-srv-"));

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quack-remotes-test-"));
  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "sessions.jsonl"), "", "utf-8");

  const monitor = createMonitorServer({
    logDir,
    adapterPath: undefined,
    projectRoot: tmpDir,
  });

  await new Promise<void>((resolve) => {
    server = monitor.app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset config to empty remotes before each test
  const configDir = path.join(tmpHome, ".quack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ projects: [], monitor: { port: 3333 }, remoteInstances: [] }),
    "utf-8",
  );
});

// ─── Tests ───────────────────────────────────────────────────────

describe("GET /api/remotes", () => {
  it("returns empty array when no remotes configured", async () => {
    const res = await httpGet(`${baseUrl}/api/remotes`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe("POST /api/remotes", () => {
  it("creates a remote and persists to config", async () => {
    const res = await httpRequest("POST", `${baseUrl}/api/remotes`, {
      alias: "test_remote",
      host: "192.168.1.100",
      localPort: 4000,
      remotePort: 4000,
      sshTarget: "user@192.168.1.100",
      sshKeyPath: "~/.ssh/test_key",
      enabled: true,
    });

    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.remote.id).toBe("test-remote");
    expect(body.remote.alias).toBe("test_remote");

    // Verify it persisted
    const listRes = await httpGet(`${baseUrl}/api/remotes`);
    const remotes = JSON.parse(listRes.body);
    expect(remotes).toHaveLength(1);
    expect(remotes[0].alias).toBe("test_remote");
  });

  it("returns 400 for invalid config", async () => {
    const res = await httpRequest("POST", `${baseUrl}/api/remotes`, {
      alias: "",
      host: "",
      localPort: 80,
      remotePort: 99999,
      sshTarget: "invalid",
      sshKeyPath: "",
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe("PUT /api/remotes/:id", () => {
  it("updates fields and persists", async () => {
    // Create first
    await httpRequest("POST", `${baseUrl}/api/remotes`, {
      alias: "original",
      host: "10.0.0.1",
      localPort: 5000,
      remotePort: 5000,
      sshTarget: "admin@10.0.0.1",
      sshKeyPath: "~/.ssh/key",
      enabled: true,
    });

    // Update
    const res = await httpRequest("PUT", `${baseUrl}/api/remotes/original`, {
      alias: "updated_name",
      host: "10.0.0.2",
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.remote.alias).toBe("updated_name");
    expect(body.remote.host).toBe("10.0.0.2");
    expect(body.remote.localPort).toBe(5000); // unchanged
  });

  it("returns 404 for unknown remote", async () => {
    const res = await httpRequest("PUT", `${baseUrl}/api/remotes/nonexistent`, {
      alias: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/remotes/:id", () => {
  it("removes remote from config", async () => {
    // Create
    await httpRequest("POST", `${baseUrl}/api/remotes`, {
      alias: "to_delete",
      host: "1.2.3.4",
      localPort: 6000,
      remotePort: 6000,
      sshTarget: "user@1.2.3.4",
      sshKeyPath: "~/.ssh/key",
      enabled: true,
    });

    // Delete
    const res = await httpRequest("DELETE", `${baseUrl}/api/remotes/to-delete`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    // Verify gone
    const listRes = await httpGet(`${baseUrl}/api/remotes`);
    expect(JSON.parse(listRes.body)).toEqual([]);
  });

  it("returns 404 for unknown remote", async () => {
    const res = await httpRequest("DELETE", `${baseUrl}/api/remotes/nonexistent`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/remotes/:id/health", () => {
  it("returns 502 when remote is unreachable", async () => {
    // Create a remote pointing to a port nothing listens on
    await httpRequest("POST", `${baseUrl}/api/remotes`, {
      alias: "dead_remote",
      host: "127.0.0.1",
      localPort: 59999,
      remotePort: 59999,
      sshTarget: "user@127.0.0.1",
      sshKeyPath: "~/.ssh/key",
      enabled: true,
    });

    const res = await httpGet(`${baseUrl}/api/remotes/dead-remote/health`);
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Remote unreachable");
    expect(body.details).toBeDefined();
  });

  it("returns 404 for unknown remote", async () => {
    const res = await httpGet(`${baseUrl}/api/remotes/nonexistent/health`);
    expect(res.status).toBe(404);
  });
});

describe("CORS headers", () => {
  it("includes Access-Control-Allow-Origin for localhost origin", async () => {
    return new Promise<void>((resolve, reject) => {
      const urlObj = new URL(`${baseUrl}/api/remotes`);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: "OPTIONS",
          headers: { Origin: "http://localhost:3333" },
        },
        (res) => {
          expect(res.statusCode).toBe(204);
          expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3333");
          res.resume();
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
});
