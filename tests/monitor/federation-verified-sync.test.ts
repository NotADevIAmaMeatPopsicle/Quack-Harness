import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { QuackDB } from "../../src/db";
import { createMonitorServer } from "../../src/monitor/server";
import { pullVerifiedFromPeer } from "../../src/monitor/federation/verified-sync";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeAuthConfig(quackRoot: string): void {
  const dir = path.join(quackRoot, ".quack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify(
      {
        users: [],
        serviceTokens: [
          {
            id: "fed-both",
            tokenHash: sha256("fed-both-token"),
            scopes: ["federation:read", "federation:write"],
          },
          {
            id: "fed-read",
            tokenHash: sha256("fed-read-token"),
            scopes: ["federation:read"],
          },
        ],
        sessionSecret: "test",
        sessionTtlMs: 86_400_000,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeTaskFile(projectRoot: string, taskId: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, `${taskId}-fixture.md`),
    [
      `# ${taskId}: Federation Verified Fixture`,
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 1-2 hours",
      "- **Status:** READY",
      "- **Blocked By:** []",
      "- **Tags:** [federation, verification]",
      "",
      "## Problem Statement",
      "Fixture.",
      "",
      "## Success Criteria",
      "- [ ] Fixture works",
      "",
      "## Testing Requirements",
      "- [ ] API test passes",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeCcusageCache(projectRoot: string): void {
  const cacheDir = path.join(projectRoot, ".quack", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "ccusage.json"),
    JSON.stringify(
      {
        daily: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalCost: 0,
          totalTokens: 0,
        },
        lastRefreshedAt: "2026-05-02T12:00:00.000Z",
        lastFetchedDate: "20260502",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 75,
      });
      return;
    } catch {
      await pause(125);
    }
  }
}

async function httpGet(
  url: string,
  token = "fed-read-token",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    http
      .get(url, { headers }, (res) => {
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

async function httpPost(
  url: string,
  data: Record<string, unknown>,
  token = "fed-both-token",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

interface FederationVerifiedPostResponse {
  ok: boolean;
  accepted: number;
  appliedTaskIds?: string[];
  skipped?: Array<{ taskId: string; reason: string }>;
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}

describe("federation verified sync", () => {
  let projectRoot: string;
  let quackRoot: string;
  let baseUrl: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    projectRoot = makeTempDir("quack-fed-verified-project-");
    quackRoot = makeTempDir("quack-fed-verified-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-838");
    writeTaskFile(projectRoot, "TASK-839");

    const port = 48000 + Math.floor(Math.random() * 1000);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port,
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${port}`;
    await pause(150);
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await pause(150);
    await cleanupDir(projectRoot);
    await cleanupDir(quackRoot);
  });

  it("round-trips verified rows through federation verified endpoints", async () => {
    const post = await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "abc1234",
          method: "federation-sync",
          criteriaChecked: 3,
          criteriaPassed: 3,
          reviewId: "review-task-838",
          workflowId: "workflow-task-838",
          verifiedAt: "2026-05-02",
          updatedAt: "2026-05-02T12:00:00.000Z",
        },
      ],
    });
    expect(post.status).toBe(200);
    expect(JSON.parse(post.body)).toMatchObject({
      ok: true,
      accepted: 1,
      appliedTaskIds: ["TASK-838"],
    });

    const listed = await httpGet(
      `${baseUrl}/v1/federation/verified?since=2026-05-01T00:00:00.000Z`,
    );
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({
          task_id: "TASK-838",
          commit_sha: "abc1234",
          verdict: "VERIFIED",
          updated_at: "2026-05-02T12:00:00.000Z",
        }),
      ],
    });

    const single = await httpGet(`${baseUrl}/v1/federation/verified/TASK-838`);
    expect(single.status).toBe(200);
    const singleBody = parseJson(single.body) as {
      ok: boolean;
      row: { task_id: string; commit_sha: string };
    };
    expect(singleBody.ok).toBe(true);
    expect(singleBody.row).toMatchObject({
      task_id: "TASK-838",
      commit_sha: "abc1234",
    });
  });

  it("applies clean entries and names contested refusals in one verified batch", async () => {
    const taskDir = path.join(projectRoot, "docs", "tasks");
    const source = fs.readdirSync(taskDir).find((name) => name.startsWith("TASK-838-"));
    if (!source) throw new Error("TASK-838 fixture not found");
    fs.copyFileSync(path.join(taskDir, source), path.join(taskDir, "TASK-999-duplicate.md"));

    const post = await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "contested123",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
        {
          taskId: "TASK-839",
          verdict: "VERIFIED",
          commitSha: "clean123",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      ],
    });

    expect(post.status).toBe(200);
    const result = JSON.parse(post.body) as {
      accepted: number;
      appliedTaskIds: string[];
      refusedTaskIds: string[];
      refused: Array<{ taskId: string; claimants: string[] }>;
    };
    expect(result.accepted).toBe(1);
    expect(result.appliedTaskIds).toEqual(["TASK-839"]);
    expect(result.refusedTaskIds).toEqual(["TASK-838"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.taskId).toBe("TASK-838");
    expect(result.refused[0]?.claimants).toContain(source);
    expect(result.refused[0]?.claimants).toContain("TASK-999-duplicate.md");
    const contested = await httpGet(`${baseUrl}/v1/federation/verified/TASK-838`);
    const clean = await httpGet(`${baseUrl}/v1/federation/verified/TASK-839`);
    expect((JSON.parse(contested.body) as { row: unknown }).row).toBeNull();
    expect(
      (JSON.parse(clean.body) as { row: { task_id: string; commit_sha: string } }).row,
    ).toMatchObject({
      task_id: "TASK-839",
      commit_sha: "clean123",
    });
    const projection = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, unknown> };
    expect(projection.tasks["TASK-838"]).toBeUndefined();
    expect(projection.tasks["TASK-839"]).toBeDefined();
  });

  it("fails the verified aggregate closed when the configured task directory is unavailable", async () => {
    fs.rmSync(path.join(projectRoot, "docs", "tasks"), { recursive: true, force: true });

    const post = await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "unavailable123",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      ],
    });

    expect(post.status).toBe(200);
    const result = JSON.parse(post.body) as {
      accepted: number;
      appliedTaskIds: string[];
      refusedTaskIds: string[];
      refused: Array<{ taskId: string; claimants: string[]; reason: string }>;
      unavailable: string;
    };
    expect(result.accepted).toBe(0);
    expect(result.appliedTaskIds).toEqual([]);
    expect(result.refusedTaskIds).toEqual(["TASK-838"]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.taskId).toBe("TASK-838");
    expect(result.refused[0]?.claimants).toEqual([]);
    expect(result.refused[0]?.reason).toContain("scan unavailable");
    expect(result.unavailable).toContain("Duplicate claimant scan failed");
    const single = await httpGet(`${baseUrl}/v1/federation/verified/TASK-838`);
    expect((JSON.parse(single.body) as { row: unknown }).row).toBeNull();
  });

  it("does not let stale peer rows overwrite newer local verification", async () => {
    await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "zzz9999",
          method: "federation-sync",
          criteriaChecked: 3,
          criteriaPassed: 3,
          verifiedAt: "2026-05-02",
          updatedAt: "2026-05-02T12:30:00.000Z",
        },
      ],
    });

    const stale = await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "aaa1111",
          method: "federation-sync",
          criteriaChecked: 3,
          criteriaPassed: 3,
          verifiedAt: "2026-05-01",
          updatedAt: "2026-05-01T12:00:00.000Z",
        },
      ],
    });
    expect(stale.status).toBe(200);
    const staleBody = parseJson(stale.body) as FederationVerifiedPostResponse;
    expect(staleBody).toMatchObject({
      ok: true,
      accepted: 0,
      skipped: [{ taskId: "TASK-838", reason: "stale" }],
    });

    const single = await httpGet(`${baseUrl}/v1/federation/verified/TASK-838`);
    const singleBody = parseJson(single.body) as {
      row: { commit_sha: string; updated_at: string };
    };
    expect(singleBody.row).toMatchObject({
      commit_sha: "zzz9999",
      updated_at: "2026-05-02T12:30:00.000Z",
    });
  });

  it("filters federation verified rows by since cursor", async () => {
    await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "abc1234",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
          verifiedAt: "2026-05-02",
          updatedAt: "2026-05-02T12:00:00.000Z",
        },
        {
          taskId: "TASK-839",
          verdict: "VERIFIED",
          commitSha: "def5678",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
          verifiedAt: "2026-05-02",
          updatedAt: "2026-05-02T13:00:00.000Z",
        },
      ],
    });

    const listed = await httpGet(
      `${baseUrl}/v1/federation/verified?since=2026-05-02T12:30:00.000Z`,
    );
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      ok: true,
      rows: [
        expect.objectContaining({
          task_id: "TASK-839",
          commit_sha: "def5678",
        }),
      ],
    });
  });

  it("pulls verified rows from a peer monitor into a local project", async () => {
    await httpPost(`${baseUrl}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-838",
          verdict: "VERIFIED",
          commitSha: "peer1234",
          method: "federation-sync",
          criteriaChecked: 2,
          criteriaPassed: 2,
          reviewId: "review-task-838",
          verifiedAt: "2026-05-02",
          updatedAt: "2026-05-02T14:00:00.000Z",
        },
      ],
    });

    const targetRoot = makeTempDir("quack-fed-verified-target-");
    fs.mkdirSync(path.join(targetRoot, ".quack"), { recursive: true });
    writeTaskFile(targetRoot, "TASK-838");
    const targetDb = new QuackDB(path.join(targetRoot, ".quack", "quack.db"));
    try {
      const result = await pullVerifiedFromPeer(
        {
          projectId: "target",
          projectRoot: targetRoot,
          taskDir: path.join(targetRoot, "docs", "tasks"),
          db: targetDb,
        },
        {
          url: baseUrl,
          serviceToken: "fed-both-token",
          syncIntervalMs: 300_000,
          syncOnStartup: true,
          pushOnWrite: true,
          limit: 250,
        },
      );

      expect(result).toMatchObject({ fetched: 1, applied: 1, skipped: 0 });
      expect(targetDb.getVerified("TASK-838")).toMatchObject({
        task_id: "TASK-838",
        commit_sha: "peer1234",
      });

      const verified = JSON.parse(
        fs.readFileSync(path.join(targetRoot, ".quack", "verified.json"), "utf-8"),
      ) as { tasks: Record<string, { commit: string; reviewId?: string }> };
      expect(verified.tasks["TASK-838"]).toMatchObject({
        commit: "peer1234",
        reviewId: "review-task-838",
      });
    } finally {
      targetDb.close();
      await cleanupDir(targetRoot);
    }
  });
});
