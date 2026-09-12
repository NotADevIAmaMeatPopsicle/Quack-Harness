import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { loadAdapter } from "../../src/core/adapter-loader";
import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-adapter-bundle-api-"));
}

function cleanupDir(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function writeAdapter(projectRoot: string): void {
  const quackDir = path.join(projectRoot, ".quack");
  fs.mkdirSync(quackDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(quackDir, "adapter.json"),
    JSON.stringify(
      {
        version: "1.0",
        project: {
          name: "bundle-api-project",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        verification: {
          commands: [
            {
              name: "tests",
              command: "npm test",
              required: true,
              timeout: 1000,
            },
          ],
        },
        git: {
          commitFormat: "test: {taskId}",
          commitTrailer: "Task: {taskId}",
        },
        logging: {
          dir: ".quack/logs",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("adapter bundle metadata API", () => {
  let projectRoot: string;
  let baseUrl: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    writeAdapter(projectRoot);
    const adapter = await loadAdapter(projectRoot);
    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      projectAdapters: [adapter],
      runtimeRole: "worker",
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    cleanupDir(projectRoot);
  });

  it("includes authoritative adapter bundle metadata in the project list", async () => {
    const resp = await httpGet(`${baseUrl}/api/projects`);
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as Array<{
      id: string;
      adapterBundle?: {
        sharedHash: string;
        authority: string;
        machineLocalFields: string[];
      };
    }>;

    expect(body).toHaveLength(1);
    expect(body[0].adapterBundle?.authority).toBe("headnode");
    expect(body[0].adapterBundle?.machineLocalFields).toContain("project.root");
    expect(body[0].adapterBundle?.machineLocalFields).toContain("logging.dir");
    expect(body[0].adapterBundle?.sharedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("includes authoritative adapter bundle metadata in project detail", async () => {
    const listResp = await httpGet(`${baseUrl}/api/projects`);
    const [project] = JSON.parse(listResp.body) as Array<{ id: string }>;
    const detailResp = await httpGet(`${baseUrl}/api/projects/${project.id}`);
    expect(detailResp.status).toBe(200);
    const detail = JSON.parse(detailResp.body) as {
      adapterBundle?: {
        sharedHash: string;
        normalizedConfig: {
          project: { root: string };
          logging: { dir: string };
        };
      };
    };

    expect(detail.adapterBundle?.sharedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(detail.adapterBundle?.normalizedConfig.project.root).toBe(
      "<machine-local:project.root>",
    );
    expect(detail.adapterBundle?.normalizedConfig.logging.dir).toBe("<machine-local:logging.dir>");
  });
});
