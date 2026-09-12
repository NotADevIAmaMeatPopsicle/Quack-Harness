import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createMonitorServer } from "../../src/monitor/server";
import { generateProjectId } from "../../src/monitor/project-registry";
import {
  DispatchObservationStore,
  type DispatchObservationIdentity,
} from "../../src/monitor/dispatch-observation-store";
import type { DispatchJob } from "../../src/monitor/dispatch-manager";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }),
}));

function get(
  port: number,
  route: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: route }, (response) => {
      let content = "";
      response.on("data", (chunk: Buffer) => {
        content += chunk.toString();
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(content) as Record<string, unknown>,
        }),
      );
    });
    request.on("error", reject);
  });
}

describe("exact dispatch observation HTTP reads", () => {
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let identity: DispatchObservationIdentity;
  let store: DispatchObservationStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-observation-api-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack/logs"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../fixtures/task-valid-minimal.md"),
      path.join(root, "docs/tasks/TASK-001.md"),
    );
    identity = {
      projectId: generateProjectId(root),
      taskId: "TASK-001",
      jobId: "fed-original",
      hostId: "worker",
      leaseId: "lease-original",
      sessionId: "session-original",
    };
    store = new DispatchObservationStore(root, identity.projectId);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (stop) await stop();
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      stop = undefined;
    }
  });
  async function start(): Promise<number> {
    const runtime = await createMonitorServer({
      projectRoot: root,
      taskDir: "docs/tasks",
      logDir: path.join(root, ".quack/logs"),
      host: "127.0.0.1",
      port: 0,
    }).start();
    stop = runtime.stop;
    return runtime.port;
  }
  function route(value = identity): string {
    return `/api/tasks/${value.taskId}/dispatch/observation?${new URLSearchParams({ projectId: value.projectId, jobId: value.jobId, hostId: value.hostId, leaseId: value.leaseId, sessionId: value.sessionId }).toString()}`;
  }
  function save(value = identity): void {
    const job: DispatchJob = {
      taskId: value.taskId,
      sessionId: value.sessionId,
      pid: 42,
      startedAt: "2026-09-11T01:00:00.000Z",
      status: "completed",
      exitCode: 0,
      output: ["closed original attempt"],
      federatedJobId: value.jobId,
      federatedHostId: value.hostId,
      federatedLeaseId: value.leaseId,
    };
    store.write(value, job, "2026-09-11T02:00:00.000Z");
  }
  it("returns the exact persisted attempt after restart despite a newer same-task result", async () => {
    save();
    save({ ...identity, jobId: "fed-newer", leaseId: "lease-newer", sessionId: "session-newer" });
    let port = await start();
    const original = await get(port, route());
    expect(original).toMatchObject({
      status: 200,
      body: {
        identity,
        source: "durable",
        settled: true,
        job: { sessionId: "session-original", completedAt: "2026-09-11T02:00:00.000Z" },
      },
    });
    await stop!();
    stop = undefined;
    port = await start();
    expect(await get(port, route())).toEqual(original);
    for (const field of ["jobId", "hostId", "leaseId", "sessionId"] as const) {
      expect((await get(port, route({ ...identity, [field]: "wrong" }))).status).toBe(404);
    }
    expect(
      (await get(port, `/api/tasks/TASK-001/dispatch/observation?projectId=${identity.projectId}`))
        .status,
    ).toBe(400);
  });
  it("reports malformed durable bytes as unavailable and preserves the evidence", async () => {
    save();
    const dir = path.join(root, ".quack/dispatch-observations");
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const malformed = '{"identity":null}';
    fs.writeFileSync(file, malformed);
    const port = await start();
    expect((await get(port, route())).status).toBe(503);
    expect(fs.readFileSync(file, "utf-8")).toBe(malformed);
  });
});
