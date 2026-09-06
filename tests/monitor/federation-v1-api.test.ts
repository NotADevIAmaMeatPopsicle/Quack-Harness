import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { createMonitorServer } from "../../src/monitor/server";

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

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
            id: "fed-test",
            tokenHash: sha256("fed-token"),
            scopes: [
              "federation:write",
              "listener:admin",
              "listener:read",
              "listener:register",
              "listener:heartbeat",
            ],
          },
        ],
        sessionSecret: "test",
        sessionTtlMs: 86400000,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeTaskFile(
  projectRoot: string,
  taskId: string,
  options: { status?: string; blockedBy?: string[] } = {},
): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const blockedBy =
    options.blockedBy && options.blockedBy.length > 0 ? `[${options.blockedBy.join(", ")}]` : "[]";
  const content = [
    `# ${taskId}: Federation Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${options.status ?? "READY"}`,
    `- **Blocked By:** ${blockedBy}`,
    "- **Tags:** [federation, api]",
    "",
    "## Problem Statement",
    "Federation fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project federation events.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/federation/job-router.ts` | Create | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Federation API returns deterministic routing",
    "",
    "## Testing Requirements",
    "- [ ] API test passes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
}

function writePassingPrep(projectRoot: string, taskId: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, `${taskId}.json`),
    JSON.stringify(
      {
        taskId,
        preparedAt: "2999-01-01T00:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.9,
        depthReady: true,
        deficiencies: [],
        outcome: "pass",
        stale: false,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writePrep(
  projectRoot: string,
  taskId: string,
  depthScore: number,
  depthReady: boolean,
): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, `${taskId}.json`),
    JSON.stringify(
      {
        taskId,
        preparedAt: "2999-01-01T00:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore,
        depthReady,
        deficiencies: depthReady ? [] : ["Needs more implementation detail"],
        outcome: depthReady ? "pass" : "rejected",
        stale: false,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writePassingPreflight(projectRoot: string, taskId: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  const taskFilePath = path.join(projectRoot, "docs", "tasks", `${taskId}-fixture.md`);
  const taskContent = fs.readFileSync(taskFilePath, "utf-8");
  fs.writeFileSync(
    path.join(prepDir, `${taskId}-preflight.json`),
    JSON.stringify(
      {
        taskId,
        timestamp: "2999-01-01T00:00:00.000Z",
        contentHash: sha256(taskContent),
        gate: {
          ready: true,
          score: 5.0,
          dimensions: {},
        },
        blueprint: {
          fileAnalyses: 1,
          codeExamples: 0,
          verificationPatterns: 1,
          antiPatterns: 0,
          formattedMarkdown: "## Blueprint\n\nFixture",
        },
        contextEstimate: {
          taskSpec: 100,
          blueprint: 100,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 200,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 1,
          successCriteria: 1,
          estimatedContextTokens: 200,
          independentFeatures: 1,
          featureClusters: [],
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      },
      null,
      2,
    ),
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
        lastRefreshedAt: "2026-04-26T12:00:00.000Z",
        lastFetchedDate: "20260426",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitMergeFixture(projectRoot: string): void {
  git(projectRoot, ["init"]);
  git(projectRoot, ["config", "user.email", "quack-test@example.test"]);
  git(projectRoot, ["config", "user.name", "Quack Test"]);
  git(projectRoot, ["checkout", "-b", "dev"]);
  const sourceDir = path.join(projectRoot, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "fixture.txt"), "base\n", "utf-8");
  git(projectRoot, ["add", "."]);
  git(projectRoot, ["commit", "-m", "initial fixture"]);
  const remotePath = path.join(projectRoot, ".quack", "origin.git");
  fs.mkdirSync(path.dirname(remotePath), { recursive: true });
  execFileSync("git", ["init", "--bare", remotePath], { stdio: ["ignore", "pipe", "pipe"] });
  git(projectRoot, ["remote", "add", "origin", remotePath]);
  git(projectRoot, ["push", "-u", "origin", "dev"]);
  git(projectRoot, ["checkout", "-b", "quack/TASK-838"]);
  fs.writeFileSync(path.join(sourceDir, "fixture.txt"), "worker change\n", "utf-8");
  git(projectRoot, ["add", "src/fixture.txt"]);
  git(projectRoot, ["commit", "-m", "task 838 worker change"]);
  git(projectRoot, ["checkout", "dev"]);
}

function writeMergeReadyReview(projectRoot: string, taskId: string, reviewId: string): void {
  const reviewsDir = path.join(projectRoot, ".quack", "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reviewsDir, `${reviewId}.json`),
    JSON.stringify(
      {
        taskId,
        reviewId,
        verdict: "VERIFIED",
        docsImpact: "none",
        wikiArtifacts: [],
        findings: [],
        createdAt: "2026-04-28T12:00:00.000Z",
        gate: {
          mergeReady: true,
          requiredWikiActions: [],
          missingWikiActions: [],
          issues: [],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(reviewsDir, "latest-by-task.json"),
    JSON.stringify({ [taskId]: reviewId }, null, 2),
    "utf-8",
  );
}

function readSessionEvents(projectRoot: string, sessionId: string): Array<Record<string, unknown>> {
  const eventsFile = path.join(projectRoot, ".quack", "logs", `events-${sessionId}.jsonl`);
  return fs
    .readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  token = "fed-token",
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
  token = "fed-token",
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
        path: urlObj.pathname,
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

describe("v1 federation API", () => {
  let projectRoot: string;
  let quackRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = makeTempDir("quack-federation-project-");
    quackRoot = makeTempDir("quack-federation-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-838");
    writePassingPrep(projectRoot, "TASK-838");

    const port = 47000 + Math.floor(Math.random() * 1000);
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

  it("rejects federated writes without a scoped service token", async () => {
    const resp = await httpPost(
      `${baseUrl}/v1/federation/jobs`,
      {
        taskId: "TASK-838",
        hosts: [],
      },
      "",
    );

    expect(resp.status).toBe(401);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "service_token_required",
      requiredScope: "federation:write",
    });
  });

  it("submits, reads, and cancels a job assigned to a healthy host", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "headnode",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: { jobId: string; hostId: string };
      projection: { state: string };
    };
    expect(body.job.hostId).toBe("headnode");
    expect(body.projection.state).toBe("assigned");

    const fetched = await httpGet(`${baseUrl}/v1/federation/jobs/${body.job.jobId}`);
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toMatchObject({
      ok: true,
      job: { jobId: body.job.jobId, status: "assigned" },
    });

    const running = await httpPost(`${baseUrl}/v1/federation/jobs/${body.job.jobId}/events`, {
      hostId: "headnode",
      status: "running",
      remoteSessionId: "beast-task-838-001",
      message: "Worker accepted the job.",
    });
    expect(running.status).toBe(202);

    const activeSessions = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(activeSessions.status).toBe(200);
    const sessionId = `federation-${body.job.jobId}`;
    expect(JSON.parse(activeSessions.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          title: "Federation Fixture",
          status: "active",
        }),
      ]),
    );
    const runningEvents = readSessionEvents(projectRoot, sessionId);
    expect(runningEvents.find((event) => event.stage === "session_start")).toMatchObject({
      payload: {
        taskTitle: "Federation Fixture",
        taskDescription: "Federation fixture.",
      },
    });

    const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${body.job.jobId}/cancel`, {});
    expect(canceled.status).toBe(200);
    expect(JSON.parse(canceled.body)).toMatchObject({
      ok: true,
      job: { status: "canceled", canceledBy: "fed-test" },
      projection: { state: "canceled" },
    });

    const sessionsAfterCancel = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(sessionsAfterCancel.status).toBe(200);
    expect(JSON.parse(sessionsAfterCancel.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          title: "Federation Fixture",
          status: "completed",
          outcome: "canceled",
        }),
      ]),
    );
  });

  it("requires a scoped token for federation queue and job reads", async () => {
    const queue = await httpGet(`${baseUrl}/v1/federation/queue`, "");
    expect(queue.status).toBe(401);
    expect(JSON.parse(queue.body)).toMatchObject({ error: "service_token_required" });

    const job = await httpGet(`${baseUrl}/v1/federation/jobs/example-job`, "");
    expect(job.status).toBe(401);
    expect(JSON.parse(job.body)).toMatchObject({ error: "service_token_required" });
  });

  it("releases the lease and marks nextAction when a worker reports a terminal failure", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "headnode",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(queued.status).toBe(202);
    const queuedBody = parseJson<{
      job: { jobId: string; status: string; hostId: string; lease?: { hostId: string } };
    }>(queued.body);
    expect(queuedBody.job.status).toBe("assigned");
    expect(queuedBody.job.lease?.hostId).toBe("headnode");

    const failed = await httpPost(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`, {
      hostId: "headnode",
      status: "failed",
      remoteSessionId: "beast-task-838-failed",
      message: "Judge evaluation failed after retry: Claude Code process exited with code 1",
      events: [
        {
          stage: "session_error",
          sessionId: "beast-task-838-failed",
          payload: {
            error: "Judge evaluation failed after retry: Claude Code process exited with code 1",
            failedStage: "unknown",
          },
        },
      ],
      evidence: [
        {
          type: "worker_execution",
          taskId: "TASK-838",
          status: "failed",
          outputTail: [
            "Judge evaluation failed after retry: Claude Code process exited with code 1",
          ],
        },
      ],
    });

    expect(failed.status).toBe(202);
    const failedBody = parseJson<{
      job: {
        jobId: string;
        status: string;
        nextAction: string;
        lease?: unknown;
        error?: string;
        completedAt?: string;
      };
      projection: { state: string };
    }>(failed.body);
    expect(failedBody.job.status).toBe("failed");
    expect(failedBody.job.nextAction).toBe("investigate_failed_worker");
    expect(failedBody.job.lease).toBeUndefined();
    expect(failedBody.job.error).toContain("Judge evaluation failed after retry");
    expect(failedBody.job.completedAt).toBeDefined();
    expect(failedBody.projection.state).toBe("failed");

    const sessionId = `federation-${queuedBody.job.jobId}`;
    const sessionEvents = readSessionEvents(projectRoot, sessionId);
    expect(sessionEvents.some((event) => event.stage === "session_error")).toBe(true);

    const sessions = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(sessions.status).toBe(200);
    expect(JSON.parse(sessions.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          status: "error",
          outcome: "failed",
        }),
      ]),
    );
  });

  // ─── TASK-1329 round-2 R2-5 ───────────────────────────────────────
  // `awaiting_approval` is a CLAIM about disk state and has to be earned. If the
  // wire accepts it bare, nextAction degrades to a gate it cannot name and the
  // operator is told to decide something the record does not identify.
  it("refuses awaiting_approval without a pendingGate, and accepts it with one", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-1329-relay",
      jobType: "dispatch",
      hosts: [{ id: "headnode", capabilities: ["dispatch"], enabled: true, healthy: true }],
      requiredCapabilities: ["dispatch"],
    });
    expect(created.status).toBe(202);
    const jobId = (JSON.parse(created.body) as { job: { jobId: string } }).job.jobId;

    const bare = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "headnode",
      status: "awaiting_approval",
      message: "paused, but naming no gate",
    });
    expect(bare.status).toBe(400);
    expect(bare.body).toContain("pendingGate");

    const earned = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "headnode",
      status: "awaiting_approval",
      message: "paused at the brief gate",
      pendingGate: { stage: "blueprint", since: "2026-08-14T00:00:00.000Z" },
    });
    expect(earned.status).toBe(202);
    // The queue must now name the decision rather than send anyone hunting a crash.
    const body = JSON.parse(earned.body) as {
      job: { status: string; nextAction?: string; error?: string };
    };
    expect(body.job.status).toBe("awaiting_approval");
    expect(body.job.nextAction).toContain("blueprint");
    expect(body.job.error).toBeUndefined();
  });

  it("accepts remote worker status, relays Slack-friendly events, and persists evidence", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "verify",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["verify", "staging-db"],
          enabled: true,
          healthy: true,
        },
      ],
      requiredCapabilities: ["verify", "staging-db"],
    });

    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: { jobId: string } };

    const relayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${createdBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoVerify: false,
        remoteSessionId: "hex-task-838-001",
        message: "Worker-B verified waitlist evidence.",
        events: [
          {
            stage: "judge_result",
            sequence: 7,
            timestamp: "2026-04-28T12:00:00.000Z",
            payload: {
              verdict: "APPROVE",
              confidence: 0.92,
              scopeViolations: [],
              criteriaGaps: [],
              qualityIssues: [],
              feedback: "Remote worker evidence accepted.",
            },
          },
        ],
        evidence: [
          {
            type: "api_probe",
            endpoint: "/api/waitlist/matches?days=7",
            summary: "Real provider/gap/duration/service gates observed.",
          },
        ],
      },
    );

    expect(relayed.status).toBe(202);
    const body = JSON.parse(relayed.body) as {
      ok: boolean;
      relayedEvents: number;
      relayedSlackEvents: number;
      job: {
        status: string;
        hostId: string;
        remoteSessionId: string;
        eventCount: number;
        evidence: Array<Record<string, unknown>>;
      };
    };
    expect(body).toMatchObject({
      ok: true,
      relayedEvents: 1,
      relayedSlackEvents: 1,
      job: {
        status: "completed",
        hostId: "worker-b",
        remoteSessionId: "hex-task-838-001",
        eventCount: 3,
        evidence: [
          {
            type: "api_probe",
          },
        ],
      },
    });

    const sessionId = `federation-${createdBody.job.jobId}`;
    const events = readSessionEvents(projectRoot, sessionId);
    const stages = events.map((event) => event.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        "session_start",
        "federated_job_status",
        "agent_progress_update",
        "session_complete",
        "federated_job_event",
        "judge_result",
      ]),
    );
    expect(events.find((event) => event.stage === "judge_result")).toMatchObject({
      payload: {
        remote: {
          jobId: createdBody.job.jobId,
          hostId: "worker-b",
          remoteStage: "judge_result",
        },
      },
    });
  });

  it("rejects remote worker events from a different assigned host", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: { jobId: string } };

    const relayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${createdBody.job.jobId}/events`,
      {
        hostId: "contributor-laptop",
        status: "running",
        message: "Wrong host should be rejected.",
      },
    );

    expect(relayed.status).toBe(409);
    expect(JSON.parse(relayed.body)).toMatchObject({
      error: "federated_job_host_mismatch",
      expectedHostId: "worker-b",
      actualHostId: "contributor-laptop",
    });
  });

  it("registers listener hosts, accepts heartbeats, and routes jobs by capability", async () => {
    const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "contributor-laptop",
      alias: "Contributor Laptop",
      baseUrl: "http://192.0.2.30:3333",
      capabilities: ["dispatch", "verify", "staging-db", "auth"],
      maxConcurrentJobs: 1,
      repoCommit: "abc123",
      projectPaths: { example: "/home/contributor/example-service" },
    });

    expect(registered.status).toBe(201);
    expect(JSON.parse(registered.body)).toMatchObject({
      ok: true,
      listener: {
        id: "contributor-laptop",
        healthy: true,
        maxConcurrentJobs: 1,
      },
    });

    const heartbeat = await httpPost(`${baseUrl}/v1/listeners/contributor-laptop/heartbeat`, {
      healthy: true,
      currentLoad: 0,
      repoCommit: "def456",
    });

    expect(heartbeat.status).toBe(200);
    expect(JSON.parse(heartbeat.body)).toMatchObject({
      ok: true,
      listener: { id: "contributor-laptop", repoCommit: "def456" },
    });

    const listeners = await httpGet(`${baseUrl}/v1/listeners`);
    expect(listeners.status).toBe(200);
    expect(JSON.parse(listeners.body)).toMatchObject({
      ok: true,
      listeners: [{ id: "contributor-laptop" }],
    });

    const job = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "verify",
      requiredCapabilities: ["verify", "staging-db"],
    });

    expect(job.status).toBe(202);
    expect(JSON.parse(job.body)).toMatchObject({
      ok: true,
      job: {
        hostId: "contributor-laptop",
        status: "assigned",
        lease: {
          hostId: "contributor-laptop",
        },
      },
    });
  });

  it("queues worker refresh commands through the worker refresh endpoint", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "verify"],
      maxConcurrentJobs: 1,
      projectPaths: { example: "/tmp/example" },
    });

    const refresh = await httpPost(`${baseUrl}/api/workers/worker-b/refresh`, {
      reason: "post-merge",
      repos: ["quack", "example"],
      branches: { example: "dev" },
      runCapabilityProbes: true,
    });

    expect(refresh.status).toBe(202);
    const body = JSON.parse(refresh.body) as {
      ok: boolean;
      ackPath: string;
      command: {
        kind: string;
        payload: { reason: string; repos: string[]; branches: Record<string, string> };
      };
    };
    expect(body).toMatchObject({
      ok: true,
      ackPath: "/v1/listeners/worker-b/commands/ack",
      command: {
        kind: "worker.refresh",
        payload: {
          reason: "post-merge",
          repos: ["quack", "example"],
          branches: { example: "dev" },
        },
      },
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandsBody = parseJson<{
      ok: boolean;
      commands: Array<{ kind: string; payload?: { reason?: string } }>;
    }>(commands.body);
    expect(commandsBody.ok).toBe(true);
    expect(commandsBody.commands).toHaveLength(1);
    expect(commandsBody.commands[0]?.kind).toBe("worker.refresh");
    expect(commandsBody.commands[0]?.payload?.reason).toBe("post-merge");
  });

  it("queues scheduler-owned jobs, assigns by listener capability, and renews leases", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "verify"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      leaseTtlMs: 60_000,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: {
        jobId: string;
        status: string;
        hostId: string;
        lease: { hostId: string; expiresAt: string };
      };
      scheduler: { assigned: Array<{ jobId: string }> };
    };
    expect(queuedBody.job).toMatchObject({
      status: "assigned",
      hostId: "worker-b",
      lease: { hostId: "worker-b" },
    });
    expect(queuedBody.scheduler.assigned).toEqual([
      expect.objectContaining({ jobId: queuedBody.job.jobId }),
    ]);

    const renewed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/lease/renew`,
      {
        hostId: "worker-b",
        leaseTtlMs: 120_000,
      },
    );

    expect(renewed.status).toBe(200);
    const renewedBody = JSON.parse(renewed.body) as {
      job: { status: string; hostId: string };
      lease: { expiresAt: string };
    };
    expect(renewedBody.job).toMatchObject({ status: "assigned", hostId: "worker-b" });
    expect(Date.parse(renewedBody.lease.expiresAt)).toBeGreaterThan(
      Date.parse(queuedBody.job.lease.expiresAt),
    );
  });

  it("exposes only assigned jobs for a listener host", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: "P1-HIGH",
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    const jobs = await httpGet(`${baseUrl}/v1/listeners/worker-b/jobs`);
    expect(jobs.status).toBe(200);
    expect(JSON.parse(jobs.body)).toMatchObject({
      ok: true,
      hostId: "worker-b",
      jobs: [
        expect.objectContaining({
          jobId: queuedBody.job.jobId,
          taskId: "TASK-838",
          status: "assigned",
          priority: 800,
          priorityLabel: "P1-HIGH",
        }),
      ],
    });
  });

  it("keeps dispatch jobs queued when all capable hosts are at capacity", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const first = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({
      job: { status: "assigned", hostId: "worker-b" },
    });

    const second = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 9,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(second.status).toBe(202);
    const secondBody = JSON.parse(second.body) as {
      job: { status: string; hostId?: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(secondBody).toMatchObject({
      job: {
        status: "queued",
        nextAction: "wait_for_capacity",
      },
      scheduler: {
        queuedRemaining: 1,
      },
    });
    expect(secondBody.job.hostId).toBeUndefined();
  });

  it("auto-assigns the next queued job when a worker completes and frees capacity", async () => {
    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const first = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(first.status).toBe(202);
    const firstBody = JSON.parse(first.body) as { job: { jobId: string } };

    const second = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      priority: 9,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(second.status).toBe(202);
    const secondBody = JSON.parse(second.body) as {
      job: { jobId: string; status: string; nextAction: string };
    };
    expect(secondBody.job).toMatchObject({
      status: "queued",
      nextAction: "wait_for_capacity",
    });

    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoVerify: false,
        remoteSessionId: "hex-task-838-001",
        message: "Worker finished the first job cleanly.",
      },
    );
    expect(completed.status).toBe(202);
    const completedBody = JSON.parse(completed.body) as {
      scheduler?: { assigned: Array<{ jobId: string; hostId: string; status: string }> };
    };
    expect(completedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: secondBody.job.jobId,
        hostId: "worker-b",
        status: "assigned",
      }),
    ]);

    const refilled = await httpGet(`${baseUrl}/v1/federation/jobs/${secondBody.job.jobId}`);
    expect(refilled.status).toBe(200);
    expect(JSON.parse(refilled.body)).toMatchObject({
      job: {
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("auto-assigns queued work when a listener heartbeat reports capacity returning", async () => {
    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const saturated = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 1,
    });
    expect(saturated.status).toBe(200);

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: { jobId: string; status: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(queuedBody).toMatchObject({
      job: {
        status: "queued",
        nextAction: "wait_for_capacity",
      },
      scheduler: {
        queuedRemaining: 1,
      },
    });

    const regained = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 0,
    });
    expect(regained.status).toBe(200);
    const regainedBody = JSON.parse(regained.body) as {
      scheduler?: { assigned: Array<{ jobId: string; hostId: string; status: string }> };
    };
    expect(regainedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        hostId: "worker-b",
        status: "assigned",
      }),
    ]);

    const assigned = await httpGet(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}`);
    expect(assigned.status).toBe(200);
    expect(JSON.parse(assigned.body)).toMatchObject({
      job: {
        jobId: queuedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("requires passing prep evidence before assigning dispatch jobs", async () => {
    fs.rmSync(path.join(projectRoot, ".quack", "prep", "TASK-838.json"), { force: true });
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      job: {
        status: "blocked",
        retryable: true,
        error: "preflight_gate_missing",
        nextAction: "prep_or_preflight",
      },
    });
  });

  it("accepts fresh preflight evidence even when cached prep is stale or failing", async () => {
    writePrep(projectRoot, "TASK-838", 4.1, false);
    writePassingPreflight(projectRoot, "TASK-838");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      job: {
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("releases dependency-blocked jobs when the blocker is verified", async () => {
    writeTaskFile(projectRoot, "TASK-100");
    writeTaskFile(projectRoot, "TASK-101", { blockedBy: ["TASK-100"] });
    writePassingPrep(projectRoot, "TASK-101");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const blocked = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-101",
      jobType: "dispatch",
    });
    expect(blocked.status).toBe(202);
    const blockedBody = JSON.parse(blocked.body) as { job: { jobId: string } };
    expect(JSON.parse(blocked.body)).toMatchObject({
      job: {
        status: "blocked",
        error: "blocked_by_unresolved:TASK-100",
        nextAction: "wait_for_dependencies",
      },
    });

    const verified = await httpPost(`${baseUrl}/api/tasks/TASK-100/verified`, {
      verdict: "VERIFIED",
      verified: "2026-04-28",
      commit: "abc1234",
      method: "api",
      criteria_checked: 1,
      criteria_passed: 1,
    });
    expect(verified.status).toBe(200);
    const verifiedBody = JSON.parse(verified.body) as {
      unblockedJobs: string[];
      scheduler: { assigned: Array<{ jobId: string; status: string; hostId: string }> };
    };
    expect(verifiedBody.unblockedJobs).toEqual([blockedBody.job.jobId]);
    expect(verifiedBody.scheduler.assigned).toEqual([
      expect.objectContaining({
        jobId: blockedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      }),
    ]);

    const job = await httpGet(`${baseUrl}/v1/federation/jobs/${blockedBody.job.jobId}`);
    expect(job.status).toBe(200);
    expect(JSON.parse(job.body)).toMatchObject({
      job: {
        jobId: blockedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
    expect((JSON.parse(job.body) as { job: { error?: string } }).job.error).toBeUndefined();
  });

  it("recovers expired leases and reassigns jobs on the next scheduler tick", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 1,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: { jobId: string; lease: Record<string, unknown> };
    };
    const jobPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${queuedBody.job.jobId}.json`,
    );
    const staleRecord = JSON.parse(fs.readFileSync(jobPath, "utf-8")) as Record<string, unknown>;
    staleRecord.lease = {
      ...(staleRecord.lease as Record<string, unknown>),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(jobPath, JSON.stringify(staleRecord, null, 2), "utf-8");

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      recovered: Array<{ jobId: string; retryCount: number; status: string }>;
      assigned: Array<{ jobId: string; status: string }>;
    };
    expect(tickBody.recovered).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        retryCount: 1,
        status: "queued",
      }),
    ]);
    expect(tickBody.assigned).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        status: "assigned",
      }),
    ]);
  });

  it("blocks stale started jobs instead of reassigning them, while still refilling later queued work", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    const firstQueued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 2,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(firstQueued.status).toBe(202);
    const firstBody = JSON.parse(firstQueued.body) as { job: { jobId: string } };

    const started = await httpPost(`${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}/events`, {
      hostId: "worker-b",
      status: "running",
      remoteSessionId: "remote-session-1",
      message: "worker-b started TASK-838",
    });
    expect(started.status).toBe(202);

    const saturated = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 1,
    });
    expect(saturated.status).toBe(200);

    const secondQueued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      maxRetries: 2,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(secondQueued.status).toBe(202);
    const secondBody = JSON.parse(secondQueued.body) as {
      job: { jobId: string; status: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(secondBody.job.status).toBe("queued");
    expect(secondBody.job.nextAction).toBe("wait_for_capacity");
    expect(secondBody.scheduler.queuedRemaining).toBe(1);

    const firstJobPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${firstBody.job.jobId}.json`,
    );
    const staleRecord = JSON.parse(fs.readFileSync(firstJobPath, "utf-8")) as Record<
      string,
      unknown
    >;
    staleRecord.lease = {
      ...(staleRecord.lease as Record<string, unknown>),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(firstJobPath, JSON.stringify(staleRecord, null, 2), "utf-8");

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      recovered: Array<{
        jobId: string;
        status: string;
        hostId?: string;
        error?: string;
        nextAction?: string;
      }>;
      assigned: Array<{ jobId: string; status: string; hostId?: string }>;
    };
    expect(tickBody.recovered).toEqual([
      expect.objectContaining({
        jobId: firstBody.job.jobId,
        status: "blocked",
        hostId: "worker-b",
        error: "lease_expired_after_worker_activity",
        nextAction: "investigate_stale_worker",
      }),
    ]);
    expect(tickBody.assigned).toEqual([]);

    const regained = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 0,
    });
    expect(regained.status).toBe(200);
    const regainedBody = JSON.parse(regained.body) as {
      scheduler?: { assigned: Array<{ jobId: string; status: string; hostId?: string }> };
    };
    expect(regainedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      }),
    ]);

    const recovered = await httpGet(`${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}`);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toMatchObject({
      job: {
        jobId: firstBody.job.jobId,
        status: "blocked",
        hostId: "worker-b",
        error: "lease_expired_after_worker_activity",
        nextAction: "investigate_stale_worker",
      },
    });

    const refilled = await httpGet(`${baseUrl}/v1/federation/jobs/${secondBody.job.jobId}`);
    expect(refilled.status).toBe(200);
    expect(JSON.parse(refilled.body)).toMatchObject({
      job: {
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("keeps jobs blocked when no registered host can satisfy required capabilities", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "verify",
      requiredCapabilities: ["verify", "staging-db", "impossible-capability"],
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      ok: true,
      job: {
        status: "blocked",
        retryable: false,
        blockReasonCode: "pending_remote_listener",
      },
    });
  });

  it("runs automated verification for completed worker jobs and queues bounded fix work on failure", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "fix"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 2,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        message: "Worker finished but verification found a failed gate.",
        verification: {
          requireReview: false,
          criteriaChecked: 2,
          criteriaPassed: 1,
          phaseResults: [
            {
              name: "post_task_checks",
              status: "failed",
              summary: "One required gate failed.",
            },
          ],
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: { status: string; nextAction: string; fixJobIds: string[] };
      orchestration: {
        verification: { verdict: string };
        fixJob: { jobId: string; jobType: string; parentJobId: string; status: string };
      };
    };
    expect(body.job).toMatchObject({
      status: "blocked",
      nextAction: "run_fix_job",
    });
    expect(body.orchestration.verification.verdict).toBe("FAILED");
    expect(body.orchestration.fixJob).toMatchObject({
      jobType: "fix",
      parentJobId: queuedBody.job.jobId,
      status: "queued",
    });
    expect(body.job.fixJobIds).toContain(body.orchestration.fixJob.jobId);
  });

  it("blocks auto-merge until the completed worker job has a merge-ready review", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    expect(JSON.parse(completed.body)).toMatchObject({
      job: {
        status: "blocked",
        blockReasonCode: "review_linkage_required",
        mergeStatus: "blocked",
        nextAction: "record_merge_ready_review",
      },
      orchestration: {
        verification: {
          verdict: "BLOCKED",
        },
      },
    });
  });

  it("reconciles a worker-reported verified and merged completion without a review-linkage blocker", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        workerCompletion: {
          canonicalSessionId: "quack-TASK-838-20260505-123000",
          verified: true,
          verificationWorkflowId: "workflow-task-838-worker",
          verificationVerdict: "VERIFIED",
          autoMerged: true,
          mergeTargetBranch: "dev",
          mergeCommitSha: "1234567890abcdef1234567890abcdef12345678",
        },
        verification: {
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        blockReasonCode?: string;
        mergeStatus: string;
        mergeCommitSha: string;
        nextAction: string;
        remoteSessionId: string;
        verificationWorkflowId: string;
      };
      orchestration: {
        verification: { verdict: string };
        merge: { ok: boolean; commitSha: string; commands: number };
      };
    };
    expect(body.job).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
      mergeCommitSha: "1234567890abcdef1234567890abcdef12345678",
      nextAction: "hosts_pull_dev",
      remoteSessionId: "quack-TASK-838-20260505-123000",
      verificationWorkflowId: "workflow-task-838-worker",
    });
    expect(body.job.blockReasonCode).toBeUndefined();
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");
    expect(body.orchestration.merge).toMatchObject({
      ok: true,
      commitSha: "1234567890abcdef1234567890abcdef12345678",
    });

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, { workflowId: string; verdict: string; method: string }> };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      workflowId: "workflow-task-838-worker",
      verdict: "VERIFIED",
      method: "federated-orchestrator",
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandBody = parseJson<{
      ok: boolean;
      commands: Array<{
        kind: string;
        taskId?: string;
        payload?: { branches?: Record<string, string>; reason?: string };
      }>;
    }>(commands.body);
    expect(commandBody.ok).toBe(true);
    expect(commandBody.commands[0]).toMatchObject({
      kind: "worker.refresh",
      taskId: "TASK-838",
    });
    expect(commandBody.commands[0]?.payload).toMatchObject({
      reason: "post-merge",
    });
  });

  it("reconciles a stale review-linkage blocker when a merge-ready review appears", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: false,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const blockedBody = JSON.parse(completed.body) as {
      job: { verificationWorkflowId: string; blockReasonCode: string; status: string };
    };
    expect(blockedBody.job).toMatchObject({
      status: "blocked",
      blockReasonCode: "review_linkage_required",
    });

    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");

    const reconciled = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/reconcile`,
      {},
    );

    expect(reconciled.status).toBe(200);
    const reconciledBody = JSON.parse(reconciled.body) as {
      job: {
        status: string;
        blockReasonCode?: string;
        reviewId: string;
        verificationWorkflowId: string;
      };
      orchestration: { verification: { verdict: string } };
    };
    expect(reconciledBody.job).toMatchObject({
      status: "completed",
      reviewId: "review-task-838",
      verificationWorkflowId: blockedBody.job.verificationWorkflowId,
    });
    expect(reconciledBody.job.blockReasonCode).toBeUndefined();
    expect(reconciledBody.orchestration.verification.verdict).toBe("VERIFIED");

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, { reviewId: string; workflowId: string; verdict: string }> };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      reviewId: "review-task-838",
      workflowId: blockedBody.job.verificationWorkflowId,
      verdict: "VERIFIED",
    });
  });

  it("scheduler tick reconciles stale review-linkage blockers", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: false,
    });

    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    await httpPost(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      verification: {
        requireReview: true,
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});

    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      reconciled: Array<{
        jobId: string;
        status: string;
        reviewId: string;
        blockReasonCode?: string;
      }>;
    };
    expect(tickBody.reconciled).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        status: "completed",
        reviewId: "review-task-838",
      }),
    ]);
    expect(tickBody.reconciled[0]?.blockReasonCode).toBeUndefined();
  });

  it("auto-merges verified worker branches and records listener pull commands", async () => {
    initGitMergeFixture(projectRoot);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        reviewId: "review-task-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        mergeStatus: string;
        mergeCommitSha: string;
        nextAction: string;
      };
      orchestration: {
        verification: { verdict: string };
        merge: { ok: boolean; commitSha: string; commands: number };
      };
    };
    expect(body.job).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
      nextAction: "hosts_pull_dev",
    });
    expect(body.job.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");
    expect(body.orchestration.merge.ok).toBe(true);
    expect(git(projectRoot, ["show", "dev:src/fixture.txt"])).toBe("worker change");
    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, { method: string; verdict: string; reviewId: string }> };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      method: "federated-orchestrator",
      verdict: "VERIFIED",
      reviewId: "review-task-838",
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandBody = parseJson<{
      ok: boolean;
      hostId: string;
      commands: Array<{
        commandId: string;
        kind: string;
        protocolVersion: string;
        taskId?: string;
        payload?: { branches?: Record<string, string>; reason?: string };
      }>;
    }>(commands.body);
    expect(commandBody.ok).toBe(true);
    expect(commandBody.hostId).toBe("worker-b");
    expect(commandBody.commands[0]).toMatchObject({
      kind: "worker.refresh",
      protocolVersion: "worker-command-v1",
      taskId: "TASK-838",
    });
    expect(commandBody.commands[0]?.payload).toMatchObject({
      reason: "post-merge",
    });

    const ack = await httpPost(`${baseUrl}/v1/listeners/worker-b/commands/ack`, {
      commandId: commandBody.commands[0]?.commandId,
    });
    expect(ack.status).toBe(200);
    expect(JSON.parse(ack.body)).toMatchObject({
      ok: true,
      acknowledged: [
        expect.objectContaining({
          commandId: commandBody.commands[0]?.commandId,
          acknowledgedBy: "fed-test",
        }),
      ],
    });

    const pendingCommands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(JSON.parse(pendingCommands.body)).toMatchObject({
      ok: true,
      commands: [],
    });
  });

  it("blocks auto-merge when the global merge lock is already held", async () => {
    initGitMergeFixture(projectRoot);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    fs.mkdirSync(path.join(projectRoot, ".quack", "federation"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "federation", "merge.lock"),
      JSON.stringify({ jobId: "existing-merge", taskId: "TASK-000" }),
      "utf-8",
    );
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        reviewId: "review-task-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    expect(JSON.parse(completed.body)).toMatchObject({
      job: {
        status: "blocked",
        mergeStatus: "blocked",
        mergeError: "merge_lane_busy",
        nextAction: "retry_merge_after_lane_idle",
      },
      orchestration: {
        merge: { ok: false, error: "merge_lane_busy" },
      },
    });
  });

  it("accepts an external Hermes completion and records canonical verified state", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);

    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      sourceCardId: "t_d1821fd2",
      branchName: "quack/TASK-838",
      commitSha,
      baseBranch: "dev",
      targetBranch: "dev",
      worktreePath: "C:/workspace/example-service/.hermes-worktrees/TASK-838",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: false,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Hermes validation chat checked the task diff and focused tests.",
        },
      ],
      evidence: [
        {
          kind: "command",
          command:
            "npm --prefix src test -- --runTestsByPath tests/unit/example.test.js --runInBand",
          outcome: "passed",
        },
      ],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: {
        jobId: string;
        taskId: string;
        hostId: string;
        status: string;
        branchName: string;
        targetBranch: string;
        reviewId: string;
        nextAction: string;
        decision: { source: string; sourceCardId: string; verificationClass: string };
        evidence: Array<{ kind: string; command: string; outcome: string }>;
      };
      review: { reviewId: string; mergeReady: boolean };
      orchestration: { verification: { verdict: string } };
    };
    expect(body.job).toMatchObject({
      taskId: "TASK-838",
      hostId: "external:hermes",
      status: "completed",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      nextAction: "admin_review_merge",
      decision: {
        source: "hermes",
        sourceCardId: "t_d1821fd2",
        verificationClass: "fast-required",
      },
      evidence: [expect.objectContaining({ kind: "command", outcome: "passed" })],
    });
    expect(body.review.mergeReady).toBe(true);
    expect(body.job.reviewId).toBe(body.review.reviewId);
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as {
      tasks: Record<string, { method: string; verdict: string; reviewId: string; commit: string }>;
    };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      method: "federated-orchestrator",
      verdict: "VERIFIED",
      reviewId: body.review.reviewId,
      commit: commitSha,
    });

    const sessionEvents = readSessionEvents(projectRoot, `federation-${body.job.jobId}`);
    expect(sessionEvents.map((event) => event.stage)).toEqual(
      expect.arrayContaining([
        "judgment_evaluation",
        "judgment_decision",
        "session_start",
        "agent_progress_update",
        "lifecycle_verify_result",
        "session_complete",
      ]),
    );
    const persistedReview = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, ".quack", "reviews", `${body.review.reviewId}.json`),
        "utf-8",
      ),
    ) as {
      gate: {
        judgmentDecision: Record<string, unknown>;
        judgmentOrchestration: { activeDecision: Record<string, unknown> };
      };
    };
    expect(persistedReview.gate.judgmentDecision).toEqual(
      persistedReview.gate.judgmentOrchestration.activeDecision,
    );
    expect(sessionEvents.find((event) => event.stage === "judgment_decision")?.payload).toEqual(
      expect.objectContaining({
        decision: persistedReview.gate.judgmentOrchestration.activeDecision,
      }),
    );
    expect(sessionEvents.find((event) => event.stage === "session_start")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        remoteSessionId: "t_d1821fd2",
        federated: true,
      },
    });
    expect(sessionEvents.find((event) => event.stage === "agent_progress_update")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        source: "hermes",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rawContent: expect.stringContaining("Hermes"),
      },
    });
    expect(sessionEvents.find((event) => event.stage === "session_complete")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        workflowState: "reviewing",
      },
    });
  });

  it("rejects an external Hermes completion when Headnode cannot resolve the branch", async () => {
    initGitMergeFixture(projectRoot);
    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      branchName: "echo/TASK-838-missing",
      commitSha: "abc1234",
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Local validation passed, but the branch is not available to Headnode.",
        },
      ],
      evidence: [],
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      ok: false,
      error: "branch_not_fetchable",
      branchName: "echo/TASK-838-missing",
      targetBranch: "dev",
    });
    if (fs.existsSync(path.join(projectRoot, ".quack", "verified.json"))) {
      const verified = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
      ) as { tasks?: Record<string, unknown> };
      expect(verified.tasks?.["TASK-838"]).toBeUndefined();
    }
  });

  it("blocks an external Hermes completion when validation evidence reports a failed phase", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 0,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "failed",
          summary: "Focused regression test failed.",
        },
      ],
      evidence: [
        {
          kind: "command",
          command:
            "npm --prefix src test -- --runTestsByPath tests/unit/example.test.js --runInBand",
          outcome: "failed",
        },
      ],
    });

    expect(resp.status).toBe(202);
    expect(JSON.parse(resp.body)).toMatchObject({
      job: {
        status: "blocked",
        mergeStatus: "not_requested",
        error: "verification_failed_fix_budget_exhausted",
        nextAction: "manual_handoff",
      },
      orchestration: {
        verification: { verdict: "FAILED" },
      },
    });
    if (fs.existsSync(path.join(projectRoot, ".quack", "verified.json"))) {
      const verified = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
      ) as { tasks?: Record<string, unknown> };
      expect(verified.tasks?.["TASK-838"]).toBeUndefined();
    }
  });

  it("auto-merges an external Hermes completion through Headnode when validation and gates pass", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);

    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      sourceCardId: "t_d1821fd2",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Separate Hermes validation chat passed the task.",
        },
      ],
      evidence: [],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: { status: string; mergeStatus: string; mergeCommitSha: string; nextAction: string };
      orchestration: { merge: { ok: boolean; commitSha: string } };
    };
    expect(body.job.status).toBe("completed");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.nextAction).toMatch(/hosts_pull_dev|merged_no_registered_hosts/);
    expect(body.orchestration.merge.ok).toBe(true);
    expect(body.job.mergeCommitSha).toBe(body.orchestration.merge.commitSha);
    expect(git(projectRoot, ["rev-parse", "dev"])).toBe(body.job.mergeCommitSha);
  });

  it("issues scoped listener invite tokens for worker registration", async () => {
    const invite = await httpPost(`${baseUrl}/v1/listeners/invites`, {
      tokenId: "contributor-worker-token",
      scopes: ["listener:register", "listener:heartbeat", "federation:write"],
    });

    expect(invite.status).toBe(201);
    const inviteBody = JSON.parse(invite.body) as { token: string; scopes: string[] };
    expect(inviteBody.token).toMatch(/^qsvc_/);
    expect(inviteBody.scopes).toEqual([
      "federation:write",
      "listener:heartbeat",
      "listener:register",
    ]);

    const registered = await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId: "worker-b",
        capabilities: ["dispatch", "verify"],
      },
      inviteBody.token,
    );

    expect(registered.status).toBe(201);
    expect(JSON.parse(registered.body)).toMatchObject({
      listener: {
        id: "worker-b",
        registeredBy: "contributor-worker-token",
      },
    });
  });

  it("returns structured host_unhealthy failures and projects blocked state", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: false,
        },
      ],
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      ok: false,
      retryable: true,
      blockReasonCode: "host_unhealthy",
      projection: {
        state: "blocked",
        blockReasonCode: "host_unhealthy",
      },
    });
  });

  it("routes completed job with workerCompletion to merged state without review-linkage blocker", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        workerCompletion: {
          canonicalSessionId: "quack-TASK-838-wc-test",
          verified: true,
          verificationVerdict: "VERIFIED",
          verificationWorkflowId: "wf-wc-test",
          autoMerged: true,
          mergeTargetBranch: "dev",
          mergeCommitSha: "aabbccddeeff00112233445566778899aabbccdd",
        },
        verification: {
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        nextAction: string;
        mergeStatus: string;
        blockReasonCode?: string;
        mergeCommitSha: string;
      };
      orchestration: {
        verification: { verdict: string };
        merge: { ok: boolean; commitSha: string };
      };
    };
    // workerCompletion.autoMerged + workerCompletion.verified → skip review cycle,
    // go straight to merged/completed
    expect(body.job.status).toBe("completed");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.mergeCommitSha).toBe("aabbccddeeff00112233445566778899aabbccdd");
    expect(body.job.nextAction).not.toBe("record_merge_ready_review");
    expect(body.job.blockReasonCode).toBeUndefined();
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");
    expect(body.orchestration.merge.ok).toBe(true);
    expect(body.orchestration.merge.commitSha).toBe("aabbccddeeff00112233445566778899aabbccdd");
  });

  it("routes completed job without workerCompletion to a verification pass, not immediate merged state", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    // Post completed with requireReview=true and NO workerCompletion
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
        // no workerCompletion field → orchestrator must run its own verify/review cycle
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        mergeStatus?: string;
        nextAction: string;
        blockReasonCode?: string;
      };
    };
    // Without workerCompletion the orchestrator runs its own verify logic and
    // blocks on review linkage — job must NOT be immediately merged
    expect(body.job.status).not.toBe("completed");
    expect(body.job.mergeStatus).not.toBe("merged");
    // The job should be blocked waiting for a review to link or blocked on some gate
    expect(["blocked", "failed"].some((s) => s === body.job.status)).toBe(true);
  });
});
