import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { QuackDB } from "../../src/db";
import { createMonitorServer } from "../../src/monitor/server";

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
            scopes: ["federation:write", "listener:admin", "listener:read"],
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

function writeTaskFile(projectRoot: string, taskId: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = [
    `# ${taskId}: Closeout Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Tags:** [federation, closeout]",
    "",
    "## Problem Statement",
    "Closeout fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project closeout.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/foo.ts` | Modify | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Closeout completes",
    "",
    "## Testing Requirements",
    "- [ ] API test passes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
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

function writeMergeReadyReview(
  projectRoot: string,
  taskId: string,
  reviewId: string,
  options: { mergeReady?: boolean } = {},
): void {
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
        createdAt: "2026-04-29T12:00:00.000Z",
        gate: {
          mergeReady: options.mergeReady ?? true,
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

interface CloseoutJobOptions {
  status?: "completed" | "running" | "blocked" | "canceled";
  nextAction?: string;
  reviewId?: string;
  hostId?: string;
  branchName?: string;
}

function writeFederationJob(
  projectRoot: string,
  jobId: string,
  taskId: string,
  options: CloseoutJobOptions = {},
): void {
  const jobsDir = path.join(projectRoot, ".quack", "federation", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = {
    jobId,
    taskId,
    jobType: "dispatch",
    status: options.status ?? "completed",
    correlationId: jobId,
    requiredCapabilities: ["dispatch"],
    priority: 900,
    retryCount: 0,
    maxRetries: 2,
    autoMerge: false,
    decision: { reason: "Test fixture" },
    nextAction: options.nextAction ?? "admin_review_merge",
    queuedAt: "2026-04-29T00:00:00.000Z",
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T01:00:00.000Z",
    hostId: options.hostId ?? "laptop",
    fallbackUsed: false,
    assignedAt: "2026-04-29T00:00:00.000Z",
    lastEventAt: "2026-04-29T00:30:00.000Z",
    eventCount: 3,
    branchName: options.branchName ?? "dev",
    commitSha: "abc1234567",
    reviewId: options.reviewId,
    verificationWorkflowId: `workflow-${taskId}-verify-test`,
    completedAt: options.status === "completed" ? "2026-04-29T00:45:00.000Z" : undefined,
  };
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(job, null, 2), "utf-8");
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
      return;
    } catch {
      await pause(125);
    }
  }
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
    // Use X-Quack-Service-Token to bypass the API-key middleware path
    // (auth disabled in tests; Bearer would be tried as API key and rejected).
    if (token) headers["X-Quack-Service-Token"] = token;
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

describe("POST /v1/federation/jobs/:jobId/admin-closeout", () => {
  let projectRoot: string;
  let quackRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;
  const taskId = "TASK-510";
  const jobId = "fed-task-fix-test";
  const reviewId = "review-task-fix-test";

  beforeEach(async () => {
    projectRoot = makeTempDir("quack-closeout-project-");
    quackRoot = makeTempDir("quack-closeout-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, taskId);

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
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

  it("rejects without federation:write scope", async () => {
    writeFederationJob(projectRoot, jobId, taskId, { reviewId });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(
      `${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`,
      {
        mergeCommitSha: "deadbeef1234",
      },
      "",
    );

    expect(resp.status).toBe(401);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "service_token_required",
      requiredScope: "federation:write",
    });
  });

  it("returns 404 when the job doesn't exist", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/nonexistent-job/admin-closeout`, {
      mergeCommitSha: "deadbeef1234",
    });

    expect(resp.status).toBe(404);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "federated_job_not_found",
    });
  });

  it("rejects when payload missing mergeCommitSha", async () => {
    writeFederationJob(projectRoot, jobId, taskId, { reviewId });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {});

    expect(resp.status).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "invalid_admin_closeout_payload",
    });
  });

  it("rejects 409 when job state is not closeout-eligible (status=running)", async () => {
    writeFederationJob(projectRoot, jobId, taskId, {
      status: "running",
      nextAction: "run_dispatch",
      reviewId,
    });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "deadbeef1234",
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "closeout_not_eligible",
      status: "running",
    });
  });

  it("accepts closeout for canceled jobs whose work was merged externally", async () => {
    writeFederationJob(projectRoot, jobId, taskId, {
      status: "canceled",
      nextAction: "admin_review_merge",
      reviewId,
    });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "5f8543cd9abc",
      mergedBranch: "dev",
      notes: "Section 17 closeout for canceled-but-merged job",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      job: { status: string; mergeStatus: string; mergeCommitSha: string; nextAction: string };
    };
    // Job stays canceled (we don't resurrect status), but merge metadata + nextAction terminal.
    expect(body.job.status).toBe("canceled");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.mergeCommitSha).toBe("5f8543cd9abc");
    expect(body.job.nextAction).toBe("merged_no_registered_hosts");
  });

  // CONTROL: terminal closeout evidence is deliberately writable. The strict
  // guard applies to the positive verification token and all downstream work.
  it("keeps contested terminal closeout writable but mints no verified token or release", async () => {
    writeFederationJob(projectRoot, jobId, taskId, { reviewId });
    writeMergeReadyReview(projectRoot, taskId, reviewId);
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", `${taskId}-fixture.md`),
      path.join(projectRoot, "docs", "tasks", "TASK-999-cross-claimant.md"),
    );

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "deadbeef1234",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      job: { status: string; error?: string; nextAction?: string };
      unblockedJobs: string[];
      scheduler?: unknown;
    };
    expect(body.job).toMatchObject({
      status: "completed",
      nextAction: "resolve_duplicate_claimants",
    });
    expect(body.job.error).toContain("duplicate_claimants:TASK-510");
    expect(body.unblockedJobs).toEqual([]);
    expect(body.scheduler).toBeUndefined();

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(db.getVerified(taskId)).toBeUndefined();
      expect(db.getStatus(taskId)).toBeUndefined();
    } finally {
      db.close();
    }
    const projection = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(projection[taskId]).toBeUndefined();
  });

  it("rejects 409 when reviewId is missing both in body and existing job", async () => {
    writeFederationJob(projectRoot, jobId, taskId);
    // No review bundle written, no reviewId on job, no reviewId in body.

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "deadbeef1234",
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "review_id_required",
    });
  });

  it("rejects 409 when review bundle is not merge-ready", async () => {
    writeFederationJob(projectRoot, jobId, taskId, { reviewId });
    writeMergeReadyReview(projectRoot, taskId, reviewId, { mergeReady: false });

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "deadbeef1234",
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "review_not_merge_ready",
      reviewId,
    });
  });

  it("happy path: closes out completed+admin_review_merge with merge-ready review", async () => {
    writeFederationJob(projectRoot, jobId, taskId, {
      reviewId,
      branchName: "dev",
    });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "5f8543cd9abc",
      mergedBranch: "dev",
      notes: "Section 17 manual merge",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      ok: boolean;
      alreadyClosedOut: boolean;
      job: {
        status: string;
        mergeStatus: string;
        mergeCommitSha: string;
        nextAction: string;
        evidence: Array<{ type?: string; mergeCommitSha?: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.alreadyClosedOut).toBe(false);
    expect(body.job.status).toBe("completed");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.mergeCommitSha).toBe("5f8543cd9abc");
    expect(body.job.nextAction).toBe("merged_no_registered_hosts");
    expect(
      body.job.evidence?.some(
        (e) => e.type === "admin_manual_merge_closeout" && e.mergeCommitSha === "5f8543cd9abc",
      ),
    ).toBe(true);

    // Confirm verified.json is updated.
    const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
    expect(fs.existsSync(verifiedPath)).toBe(true);
    const verified = JSON.parse(fs.readFileSync(verifiedPath, "utf-8")) as {
      tasks: Record<string, { commit: string; verdict: string }>;
    };
    expect(verified.tasks[taskId]).toMatchObject({ commit: "5f8543cd9abc", verdict: "VERIFIED" });
  });

  it("idempotent: second call with same SHA returns 200 alreadyClosedOut: true", async () => {
    writeFederationJob(projectRoot, jobId, taskId, { reviewId });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const first = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "abc1234567ef",
    });
    expect(first.status).toBe(200);
    expect((JSON.parse(first.body) as { alreadyClosedOut: boolean }).alreadyClosedOut).toBe(false);

    const second = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "abc1234567ef",
    });
    expect(second.status).toBe(200);
    expect((JSON.parse(second.body) as { alreadyClosedOut: boolean }).alreadyClosedOut).toBe(true);
  });

  it("accepts reviewId from payload when job has none yet", async () => {
    writeFederationJob(projectRoot, jobId, taskId);
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "feedface1234",
      reviewId,
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as { job: { reviewId: string } };
    expect(body.job.reviewId).toBe(reviewId);
  });

  it("accepts closeout for jobs at record_merge_ready_review (TASK-885 manifestation)", async () => {
    writeFederationJob(projectRoot, jobId, taskId, {
      nextAction: "record_merge_ready_review",
      reviewId,
    });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "5f8543cd9abc",
    });

    expect(resp.status).toBe(200);
  });

  it("accepts closeout for blocked jobs waiting on record_merge_ready_review", async () => {
    writeFederationJob(projectRoot, jobId, taskId, {
      status: "blocked",
      nextAction: "record_merge_ready_review",
      reviewId,
    });
    writeMergeReadyReview(projectRoot, taskId, reviewId);

    const resp = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/admin-closeout`, {
      mergeCommitSha: "5f8543cd9abc",
      mergedBranch: "main",
      notes: "Manual rescue closeout after review bundle was recorded.",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      job: { status: string; mergeStatus: string; nextAction: string; mergeCommitSha: string };
    };
    expect(body.job.status).toBe("completed");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.nextAction).toBe("merged_no_registered_hosts");
    expect(body.job.mergeCommitSha).toBe("5f8543cd9abc");
  });
});
