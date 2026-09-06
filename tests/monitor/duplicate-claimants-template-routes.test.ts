import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { createContestedTaskFixture, writeSessionLog } from "../helpers/task-1338e-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function request(
  port: number,
  method: "GET" | "POST",
  route: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers:
          method === "POST"
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : undefined,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer | string) => {
          raw += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("TASK-1338-E: contested template read and non-persisting route controls", () => {
  let stopServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stopServer) await stopServer();
    stopServer = undefined;
    jest.restoreAllMocks();
  });

  async function start(projectRoot: string, taskDir: string): Promise<number> {
    const port = await freePort();
    const monitor = createMonitorServer({
      port,
      quackRoot: projectRoot,
      projectRoot,
      taskDir,
    });
    const started = await monitor.start();
    stopServer = started.stop;
    return port;
  }

  it("keeps POST /api/templates/rebuild ungated and non-persisting", async () => {
    const fixture = createContestedTaskFixture("parent-first", "candidate", {
      status: "COMPLETE",
      relativeTaskDir: "project/custom-task-specs",
    });
    writeSessionLog(fixture.root, [fixture.taskId]);
    try {
      const port = await start(fixture.root, fixture.relativeTaskDir);
      const response = await request(port, "POST", "/api/templates/rebuild");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, templateCount: 2 });
      expect(
        fs.existsSync(path.join(fixture.root, ".quack", "templates", "task-templates.json")),
      ).toBe(false);
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });

  it("keeps POST /api/templates/extract ungated and non-persisting", async () => {
    const fixture = createContestedTaskFixture("child-first", "cross-population", {
      status: "COMPLETE",
    });
    writeSessionLog(fixture.root, [fixture.taskId]);
    try {
      const port = await start(fixture.root, fixture.relativeTaskDir);
      const response = await request(port, "POST", "/api/templates/extract", {
        taskId: fixture.taskId,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        template: { sourceTaskId: fixture.taskId },
      });
      expect(
        fs.existsSync(path.join(fixture.root, ".quack", "templates", "task-templates.json")),
      ).toBe(false);
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });

  it("keeps GET /api/templates ungated for a contested source id", async () => {
    const fixture = createContestedTaskFixture("child-first", "candidate", {
      status: "COMPLETE",
    });
    const registryPath = path.join(fixture.root, ".quack", "templates", "task-templates.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        updatedAt: "2026-08-18T00:00:00.000Z",
        templates: [{ sourceTaskId: fixture.taskId, category: "testing" }],
        categoryStats: {},
      }),
      "utf-8",
    );
    try {
      const port = await start(fixture.root, fixture.relativeTaskDir);
      const response = await request(port, "GET", "/api/templates");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        templates: [{ sourceTaskId: fixture.taskId }],
      });
    } finally {
      if (stopServer) await stopServer();
      stopServer = undefined;
      fixture.cleanup();
    }
  });
});
