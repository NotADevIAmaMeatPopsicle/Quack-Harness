import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter } from "../../src/core/adapter-loader";
import { createMonitorServer } from "../../src/monitor/server";
import { taskSpec, writeTestAdapter } from "../helpers/divergent-task-fixture";

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

async function post(port: number): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ taskId: "TASK-260" });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/templates/extract",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

// Full-server wiring controls: the equivalent pre-change arms were first
// placed in templates-api.test.ts, but that harness did not emit within the
// 300-second sandbox window. The production route's pre-change 500 responses
// are recorded in templates-route-selection.test.ts. These controls pin the
// ResolvedProject plumbing for both server modes after that route boundary.
describe("TASK-1339-B: monitor server threads template taskDir", () => {
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-template-server-task-dir-"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    jest.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it.each<"legacy" | "registry">(["legacy", "registry"])(
    "passes the custom taskDir through %s project resolution",
    async (mode) => {
      const relativeTaskDir = "project/task-specs";
      const taskDir = path.join(projectRoot, "project", "task-specs");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, "TASK-260-server-threaded.md"),
        taskSpec("TASK-260", {
          title: "Server threaded task directory",
          status: "COMPLETE",
          tags: ["server-threaded"],
        }),
        "utf-8",
      );

      const logsDir = path.join(projectRoot, ".quack", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "sessions.jsonl"),
        `${JSON.stringify({
          taskId: "TASK-260",
          sessionId: "server-threaded-session",
          startTime: "2026-08-17T12:00:00.000Z",
          endTime: "2026-08-17T12:01:00.000Z",
          outcome: "approved",
          costUsd: 1,
          turnsUsed: 1,
          retriesUsed: 0,
          taskTags: ["server-threaded"],
          targetFiles: ["src/task-260.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 5,
          complexity: { filesToModify: 1, successCriteria: 1 },
        })}\n`,
        "utf-8",
      );

      const adapterPath = writeTestAdapter(projectRoot);
      const adapterJson = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
        project: { taskDir: string };
      };
      adapterJson.project.taskDir = relativeTaskDir;
      fs.writeFileSync(adapterPath, JSON.stringify(adapterJson, null, 2), "utf-8");

      const port = await freePort();
      const monitor =
        mode === "registry"
          ? createMonitorServer({ port, projectAdapters: [await loadAdapter(projectRoot)] })
          : createMonitorServer({ port, projectRoot, taskDir: relativeTaskDir, logDir: logsDir });
      const started = await monitor.start();
      stopServer = started.stop;

      const response = await post(port);

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        template: { sourceTaskId: "TASK-260", tags: ["server-threaded"] },
      });
    },
  );
});
