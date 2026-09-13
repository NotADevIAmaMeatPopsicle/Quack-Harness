import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

it("refuses encoded job paths without exposing neighboring configuration, and still reads jobs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-job-path-"));
  const dir = path.join(root, ".quack", "federation");
  fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  const canary = "fixture-only-public-read-canary";
  const peerBytes = JSON.stringify({ url: "http://127.0.0.1:1", serviceToken: canary,
    syncOnStartup: false, pushOnWrite: false });
  fs.writeFileSync(path.join(dir, "peer.json"), peerBytes);
  const jobId = "fed-task-1366-ordinary";
  const job = { jobId, taskId: "TASK-1366", status: "queued" };
  fs.writeFileSync(path.join(dir, "jobs", `${jobId}.json`), JSON.stringify(job));
  const server = createMonitorServer({ port: 0, host: "127.0.0.1", projectRoot: root, taskDir: "docs/tasks" });
  const started = await server.start();
  try {
    for (const id of ["..%2Fpeer", "..%5Cpeer", "NUL", "CON.json", "fed%3Astream"]) {
      const result = await get(started.port, `/v1/federation/jobs/${id}`);
      expect(result.body).not.toContain(canary);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toMatchObject({ code: "INVALID_FEDERATED_JOB_ID" });
      expect(result.body).not.toContain(decodeURIComponent(id));
    }
    expect(fs.readFileSync(path.join(dir, "peer.json"), "utf8")).toBe(peerBytes);
    const ordinary = await get(started.port, `/v1/federation/jobs/${jobId}`);
    expect(ordinary.status).toBe(200);
    expect(JSON.parse(ordinary.body)).toMatchObject({ ok: true, job });
    expect((await get(started.port, "/v1/federation/jobs/fed-absent")).status).toBe(404);
  } finally {
    await started.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
