import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { QuackDB } from "../../src/db";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { EventWriter } from "../../src/monitor/event-emitter";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { loadFederatedJob, saveFederatedJob } from "../../src/monitor/federation/store";
import { cleanupInactiveDbDispatchSessions } from "../../src/monitor/session-recovery";
import { createMonitorServer } from "../../src/monitor/server";

interface HttpResult {
  status: number;
  body: string;
  setCookie?: string;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(
  url: string,
  data: Record<string, unknown>,
  token = "fed-token",
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(data);
    const requestHeaders: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: requestHeaders,
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer | string) => {
          responseBody += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: responseBody,
            setCookie: response.headers["set-cookie"]?.[0],
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function writeTask(
  taskDir: string,
  fileName: string,
  taskId = "TASK-510",
  blockedBy: string[] = [],
): void {
  fs.writeFileSync(
    path.join(taskDir, fileName),
    [
      `# ${taskId}: restoration fixture`,
      "",
      "## Metadata",
      "- **Priority:** P2-MEDIUM",
      "- **Effort:** SMALL",
      "- **Status:** READY",
      `- **Blocked By:** [${blockedBy.join(", ")}]`,
      "- **Tags:** [federation]",
      "",
      "## Problem Statement",
      "Exercise a recovery-only status restoration.",
      "",
      "## Success Criteria",
      "- [ ] restoration remains writable",
      "",
      "## Testing Requirements",
      "- [ ] strict admission follows the restoration",
    ].join("\n"),
    "utf-8",
  );
}

function writeAuthConfig(quackRoot: string): void {
  const configDir = path.join(quackRoot, ".quack");
  fs.mkdirSync(configDir, { recursive: true });
  const passwordHash = `testsalt:${crypto.scryptSync("quack-pw", "testsalt", 64).toString("hex")}`;
  fs.writeFileSync(
    path.join(configDir, "auth.json"),
    JSON.stringify({
      users: [{ username: "operator", passwordHash, role: "admin" }],
      serviceTokens: [
        {
          id: "fed-test",
          tokenHash: crypto.createHash("sha256").update("fed-token").digest("hex"),
          scopes: ["federation:write"],
        },
      ],
      sessionSecret: "test",
      sessionTtlMs: 86400000,
    }),
    "utf-8",
  );
}

describe("TASK-1338-F recovery writes remain usable but mint no admission token", () => {
  jest.setTimeout(30000);

  let root: string;
  let quackRoot: string;
  let taskDir: string;
  let logDir: string;
  let baseUrl: string;
  let stopServer: (() => Promise<void>) | undefined;

  function database(): QuackDB {
    return new QuackDB(path.join(root, ".quack", "quack.db"));
  }

  function addContest(): void {
    writeTask(taskDir, "TASK-999-cross-claimant.md");
  }

  function seedInProgress(db: QuackDB): void {
    db.setStatus("TASK-510", "READY", "seed");
    db.setStatus("TASK-510", "IN_PROGRESS", "session_start");
  }

  async function startServer(): Promise<void> {
    const port = 49100 + Math.floor(Math.random() * 500);
    const monitor = createMonitorServer({
      projectRoot: root,
      taskDir: "docs/tasks",
      logDir,
      quackRoot,
      port,
    });
    const started = await monitor.start();
    stopServer = started.stop;
    baseUrl = `http://127.0.0.1:${port}`;
    await pause(125);
  }

  async function loginCookie(): Promise<string> {
    const login = await postJson(
      `${baseUrl}/api/auth/login`,
      { username: "operator", password: "quack-pw" },
      "",
    );
    expect(login.status).toBe(200);
    return (login.setCookie as string).split(";")[0];
  }

  async function assertAdmissionRefused(existingJobs = 0): Promise<void> {
    const before = fs.existsSync(path.join(root, ".quack", "federation", "jobs"))
      ? fs
          .readdirSync(path.join(root, ".quack", "federation", "jobs"))
          .filter((fileName) => fileName.endsWith(".json")).length
      : 0;
    expect(before).toBe(existingJobs);
    const response = await postJson(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-510",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "duplicate_claimants",
      taskId: "TASK-510",
      claimants: ["TASK-510-fixture.md", "TASK-999-cross-claimant.md"],
    });
    const after = fs.existsSync(path.join(root, ".quack", "federation", "jobs"))
      ? fs
          .readdirSync(path.join(root, ".quack", "federation", "jobs"))
          .filter((fileName) => fileName.endsWith(".json")).length
      : 0;
    expect(after).toBe(existingJobs);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-restoration-"));
    quackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1338f-restoration-auth-"));
    taskDir = path.join(root, "docs", "tasks");
    logDir = path.join(root, ".quack", "logs");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    writeTask(taskDir, "TASK-510-fixture.md");
    writeAuthConfig(quackRoot);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (stopServer) await stopServer();
    stopServer = undefined;
    await pause(100);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(quackRoot, { recursive: true, force: true });
  });

  // CONTROL: the stop write is intentionally out of the veto inventory. The
  // strict queue refusal after the actual route write is the behavioral pin.
  it("restores READY through stop-to-READY, then refuses contested federation admission", async () => {
    await startServer();
    const db = database();
    seedInProgress(db);
    addContest();
    jest.spyOn(DispatchManager.prototype, "stop").mockReturnValue(true);

    const response = await postJson(`${baseUrl}/api/tasks/TASK-510/stop`, {}, "", {
      Cookie: await loginCookie(),
    });
    expect(response.status).toBe(200);
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    db.close();
    await assertAdmissionRefused();
  });

  it("restores READY through federation cancel, then refuses contested federation admission", async () => {
    await startServer();
    const queued = await postJson(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-510",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
    });
    expect(queued.status).toBe(202);
    const jobId = (JSON.parse(queued.body) as { queued: { jobId: string } }).queued.jobId;
    const db = database();
    seedInProgress(db);
    addContest();

    const canceled = await postJson(`${baseUrl}/v1/federation/jobs/${jobId}/cancel`, {});
    expect(canceled.status).toBe(200);
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    db.close();
    await assertAdmissionRefused(1);
  });

  it("restores READY through monitor orphan cleanup, then refuses contested federation admission", async () => {
    const seed = database();
    seedInProgress(seed);
    seed.upsertSession({
      session_id: "session-orphan",
      task_id: "TASK-510",
      project: "fixture",
      title: null,
      start_time: "2026-01-01T00:00:00.000Z",
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });
    seed.close();
    addContest();

    await startServer();
    const db = database();
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    expect(db.getLatestSession("TASK-510")?.outcome).toBe("monitor_crash");
    db.close();
    await assertAdmissionRefused();
  });

  it("restores READY through the spec-stale event path, then refuses contested federation admission", async () => {
    await startServer();
    const db = database();
    seedInProgress(db);
    addContest();
    const writer = new EventWriter({
      sessionId: "session-spec-stale",
      taskId: "TASK-510",
      project: "fixture",
      logDir,
    });
    writer.emit("spec_identity_stale", {
      taskId: "TASK-510",
      reason: "fixture",
    } as never);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (db.getStatus("TASK-510")?.status === "READY") break;
      await pause(100);
    }
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    db.close();
    await assertAdmissionRefused();
  });

  it("restores READY through session recovery, then refuses contested federation admission", async () => {
    await startServer();
    const db = database();
    seedInProgress(db);
    db.upsertSession({
      session_id: "session-stale",
      task_id: "TASK-510",
      project: "fixture",
      title: null,
      start_time: "2026-01-01T00:00:00.000Z",
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    });
    addContest();

    const result = cleanupInactiveDbDispatchSessions({ db, logDir });
    expect(result.recoveredTaskIds).toEqual(["TASK-510"]);
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    db.close();
    await assertAdmissionRefused();
  });

  it("refuses public COMPLETE status while leaving non-token READY writable", async () => {
    await startServer();
    addContest();
    const cookie = await loginCookie();
    const db = database();

    const refused = await postJson(
      `${baseUrl}/api/tasks/TASK-510/status`,
      { status: "COMPLETE" },
      "",
      { Cookie: cookie },
    );
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: "duplicate_claimants",
      taskId: "TASK-510",
    });
    expect(db.getStatus("TASK-510")).toBeUndefined();

    const recoveryWrite = await postJson(
      `${baseUrl}/api/tasks/TASK-510/status`,
      { status: "READY" },
      "",
      { Cookie: cookie },
    );
    expect(recoveryWrite.status).toBe(200);
    expect(db.getStatus("TASK-510")?.status).toBe("READY");
    db.close();
  });

  it("refuses the public verified writer without changing its dependent or projection", async () => {
    writeTask(taskDir, "TASK-511-dependent.md", "TASK-511", ["TASK-510"]);
    await startServer();
    const blocked = {
      ...queueFederatedJobRecord({
        taskId: "TASK-511",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: { channel: "federation-queue" as const, tokenId: "fed-test" },
      }),
      status: "blocked" as const,
      decision: { dependencyBlockers: ["TASK-510"] },
    };
    await saveFederatedJob(root, blocked);
    const blockedBytes = fs.readFileSync(
      path.join(root, ".quack", "federation", "jobs", `${blocked.jobId}.json`),
    );
    addContest();
    const projectionPath = path.join(root, ".quack", "verified.json");
    const projectionBytes = fs.readFileSync(projectionPath);
    const db = database();

    const refused = await postJson(
      `${baseUrl}/api/tasks/TASK-510/verified`,
      {
        verdict: "VERIFIED",
        commit: "abc1234",
        method: "api",
        criteria_checked: 1,
        criteria_passed: 1,
      },
      "",
      { Cookie: await loginCookie() },
    );
    expect(refused.status).toBe(409);
    expect(db.getVerified("TASK-510")).toBeUndefined();
    expect(db.getStatus("TASK-510")).toBeUndefined();
    expect(fs.readFileSync(projectionPath)).toEqual(projectionBytes);
    expect(await loadFederatedJob(root, blocked.jobId)).toMatchObject({ status: "blocked" });
    expect(
      fs.readFileSync(path.join(root, ".quack", "federation", "jobs", `${blocked.jobId}.json`)),
    ).toEqual(blockedBytes);
    db.close();
  });

  it("keeps an approved session fact but refuses its COMPLETE token through the event writer", async () => {
    await startServer();
    addContest();
    const projectionPath = path.join(root, ".quack", "verified.json");
    const projectionBytes = fs.readFileSync(projectionPath);
    const db = database();
    const writer = new EventWriter({
      sessionId: "session-approved-contested",
      taskId: "TASK-510",
      project: "fixture",
      logDir,
    });
    writer.emit("session_complete", {
      outcome: "approved",
      durationMs: 10,
      totalCostUsd: 0,
      executionMode: "dispatch",
      recordOnFinalize: false,
      lifecycleVerified: true,
      autoMerged: true,
      mergeCommitSha: "abc1234",
    });

    const eventPath = path.join(logDir, "events-session-approved-contested.jsonl");
    let events: Array<{ stage?: string; payload?: { error?: string } }> = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      events = fs
        .readFileSync(eventPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { stage?: string; payload?: { error?: string } });
      if (events.some((event) => event.stage === "loop_finalize_record_failed")) break;
      await pause(100);
    }

    expect(db.getLatestSession("TASK-510")).toMatchObject({
      status: "completed",
      outcome: "approved",
    });
    expect(db.getStatus("TASK-510")).toBeUndefined();
    expect(db.getVerified("TASK-510")).toBeUndefined();
    expect(fs.readFileSync(projectionPath)).toEqual(projectionBytes);
    const refusal = events.find((event) => event.stage === "loop_finalize_record_failed");
    expect(refusal?.payload?.error).toContain("TASK-510-fixture.md");
    expect(refusal?.payload?.error).toContain("TASK-999-cross-claimant.md");
    db.close();
  });

  it.each([
    ["lifecycle_status_updated", { taskId: "TASK-510", newStatus: "COMPLETE" }],
    ["lifecycle_blocker_resolved", { taskId: "TASK-510", newStatus: "VERIFIED" }],
    ["lifecycle_parent_completed", { parentTaskId: "TASK-510" }],
    ["lifecycle_complete", { taskId: "TASK-510", verdict: "VERIFIED", commitSha: "abc1234" }],
  ] as const)("refuses the post-C positive token from %s", async (stage, payload) => {
    await startServer();
    addContest();
    const db = database();
    const writer = new EventWriter({
      sessionId: `session-${stage}`,
      taskId: "TASK-510",
      project: "fixture",
      logDir,
    });
    writer.emit(stage, payload as never);

    const eventPath = path.join(logDir, `events-session-${stage}.jsonl`);
    let refusal: { stage?: string; payload?: { error?: string; failedStage?: string } } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const events = fs
        .readFileSync(eventPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              stage?: string;
              payload?: { error?: string; failedStage?: string };
            },
        );
      refusal = events.find(
        (event) =>
          event.stage === "loop_finalize_record_failed" &&
          event.payload?.failedStage ===
            (stage === "lifecycle_parent_completed" ? "parent_completed" : stage),
      );
      if (refusal) break;
      await pause(100);
    }

    expect(refusal?.payload?.error).toContain("TASK-999-cross-claimant.md");
    expect(db.getStatus("TASK-510")).toBeUndefined();
    expect(db.getVerified("TASK-510")).toBeUndefined();
    db.close();
  });
});
