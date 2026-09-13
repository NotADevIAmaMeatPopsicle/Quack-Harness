import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFederatedStartClaim } from "../../src/monitor/federation/start-claim";

describe("fresh federated start authority", () => {
  let root: string;
  let peer: http.Server;
  let peerUrl: string;
  let requests: Array<{ url?: string; token?: string | string[] }>;
  let handler: (res: http.ServerResponse) => void;
  let job: Record<string, unknown>;
  let refusals: string[];

  const claim = { projectId: "local", taskId: "TASK-001", jobId: "fed-001",
    hostId: "worker", leaseId: "lease:001" };
  function config(extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(path.join(root, ".quack/federation/peer.json"), JSON.stringify({
      url: peerUrl, remoteProjectId: "remote", serviceToken: "fixture-token",
      startAuthority: { hostId: "worker" }, ...extra,
    }));
  }
  function localJob(value: unknown = { ...job, projectId: "local" }): void {
    fs.writeFileSync(path.join(root, ".quack/federation/jobs/fed-001.json"), JSON.stringify(value));
  }
  const resolve = () => resolveFederatedStartClaim({ ...claim, projectRoot: root,
    onRefusal: (reason) => { refusals.push(reason); } });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-start-claim-"));
    fs.mkdirSync(path.join(root, ".quack/federation/jobs"), { recursive: true });
    job = { ...claim, projectId: "remote", status: "assigned", secretExtra: "discard",
      lease: { leaseId: "lease:001", hostId: "worker",
        expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    requests = [];
    refusals = [];
    handler = (res) => res.end(JSON.stringify({ ok: true, job }));
    peer = http.createServer((req, res) => {
      requests.push({ url: req.url, token: req.headers["x-quack-service-token"] });
      handler(res);
    });
    await new Promise<void>((done) => peer.listen(0, "127.0.0.1", done));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("missing peer port");
    peerUrl = `http://127.0.0.1:${address.port}`;
    config();
  });
  afterEach(async () => {
    peer.closeAllConnections();
    await new Promise<void>((done, reject) => peer.close((error) => error ? reject(error) : done()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  it("reads the configured remote mapping, sends a token and strips unrelated data", async () => {
    job.jobId = "fed_001";
    await expect(resolveFederatedStartClaim({ ...claim, jobId: "fed_001", projectRoot: root })).resolves.toEqual({
      projectId: "remote", jobId: "fed_001", taskId: "TASK-001", hostId: "worker",
      status: "assigned", lease: job.lease,
    });
    expect(requests).toEqual([{ url: "/v1/federation/jobs/fed_001?projectId=remote", token: "fixture-token" }]);
    expect(fs.readdirSync(path.join(root, ".quack/federation/jobs"))).toEqual([]);
  });

  it.each(["fed:001", "../peer", "NUL", "fed-001\n"])("refuses nonportable claim ID %j without contacting the peer", async (jobId) => {
    await expect(resolveFederatedStartClaim({ ...claim, jobId, projectRoot: root })).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it.each(["projectId", "jobId", "taskId", "hostId", "status"])("refuses a mismatched %s", async (key) => {
    job[key] = "wrong";
    await expect(resolve()).resolves.toBeUndefined();
  });
  it.each(["hostId", "leaseId"])("refuses mismatched lease %s", async (key) => {
    (job.lease as Record<string, unknown>)[key] = "wrong";
    await expect(resolve()).resolves.toBeUndefined();
  });
  it.each([undefined, "bad-date", "2000-01-01T00:00:00.000Z"])("refuses local and remote expiry %s", async (expiresAt) => {
    (job.lease as Record<string, unknown>).expiresAt = expiresAt;
    await expect(resolve()).resolves.toBeUndefined();
    config({ startAuthority: undefined });
    localJob();
    await expect(resolve()).resolves.toBeUndefined();
  });
  it("uses only the local store without opt-in, and does not turn verified-sync config into authority", async () => {
    config({ startAuthority: undefined });
    localJob();
    await expect(resolve()).resolves.toMatchObject({ projectId: "local" });
    fs.unlinkSync(path.join(root, ".quack/federation/peer.json"));
    await expect(resolve()).resolves.toMatchObject({ projectId: "local" });
    expect(requests).toEqual([]);
  });
  it("never falls back to a valid local copy or caches a prior remote success", async () => {
    localJob();
    await expect(resolve()).resolves.toBeDefined();
    job.status = "canceled";
    await expect(resolve()).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  });
  it.each([
    { remoteProjectId: undefined }, { serviceToken: undefined },
    { startAuthority: { hostId: "other-worker" } }, { url: "file:///tmp/job" },
    { url: "http://user:secret@127.0.0.1" }, { url: "http://127.0.0.1?redirect=foo" },
    { url: "http://127.0.0.1#fragment" }, { url: "not a URL" },
  ])("fails closed for invalid authority config %j", async (extra) => {
    localJob();
    config(extra);
    await expect(resolve()).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
  it("contains invalid JSON and unreadable config rather than treating it as no authority", async () => {
    localJob();
    const file = path.join(root, ".quack/federation/peer.json");
    fs.writeFileSync(file, "{ broken private config");
    await expect(resolve()).resolves.toBeUndefined();
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    await expect(resolve()).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
  it.each([401, 404, 500, 302])("refuses HTTP %i and never follows redirects", async (status) => {
    handler = (res) => { res.writeHead(status, { Location: `${peerUrl}/leak` }); res.end("no"); };
    await expect(resolve()).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(refusals).toEqual([status === 302 ? "peer_unreachable" : "peer_status"]);
  });
  it.each(["not json", '{"ok":false,"job":{}}', "[]", "x".repeat(1024 * 1024 + 1)])(
    "refuses malformed or oversized response %#", async (body) => {
      handler = (res) => res.end(body);
      await expect(resolve()).resolves.toBeUndefined();
      expect(refusals).toEqual(["peer_response_invalid"]);
    });
  it("bounds a response that stalls after its headers", async () => {
    handler = (res) => { res.writeHead(200); res.write('{"ok":true,'); };
    const began = Date.now();
    await expect(resolve()).resolves.toBeUndefined();
    expect(Date.now() - began).toBeLessThan(7_000);
    expect(refusals).toEqual(["peer_timeout"]);
  });
  it("contains network failure", async () => {
    handler = (res) => res.destroy();
    await expect(resolve()).resolves.toBeUndefined();
    expect(refusals).toEqual(["peer_unreachable"]);
  });
});
