import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import express from "express";

import { createMonitorServer } from "../../src/monitor/server";
import { registerWorkflowRoutes } from "../../src/monitor/routes/workflows";
import { loadStatusOverlay } from "../../src/dispatcher/dependency-resolver";
import { recordVerification } from "../../src/monitor/verification-store";
import { QuackDB } from "../../src/db";
import { DispatchQueue } from "../../src/queue/dispatch-queue";
import { QueuePersistence } from "../../src/queue/queue-persistence";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { loadFederatedJob, saveFederatedJob } from "../../src/monitor/federation/store";
import type { FederatedJobRecord } from "../../src/monitor/federation/types";
import * as federationScheduling from "../../src/monitor/federation/scheduling";

// Prevent tests from loading real ~/.quack/auth.json
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-v1-reviews-"));
}

function writeTaskFile(
  projectRoot: string,
  taskId: string,
  status: string,
  checked = true,
  blockedBy: string[] = [],
): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const check = checked ? "x" : " ";
  const content = [
    `# ${taskId}: Test Task`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    `- **Blocked By:** [${blockedBy.join(", ")}]`,
    "",
    "## Problem Statement",
    "Test task.",
    "",
    "## Success Criteria",
    `- [${check}] Criterion 1`,
    "",
    "## Testing Requirements",
    `- [${check}] Test 1`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-test.md`), content, "utf-8");
}

function readVerifiedProjection(projectRoot: string): Record<string, Record<string, unknown>> {
  const projectionPath = path.join(projectRoot, ".quack", "verified.json");
  const raw = fs.readFileSync(projectionPath, "utf-8");
  const parsed = JSON.parse(raw) as { tasks?: Record<string, Record<string, unknown>> };
  return parsed.tasks ?? {};
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
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
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

describe("v1 reviews API", () => {
  let projectRoot: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeTaskFile(projectRoot, "TASK-920", "COMPLETE", true);
    writeTaskFile(projectRoot, "TASK-921", "IMPLEMENTED IN FRONTEND SLICE", true);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    port = started.port;
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(projectRoot);
  });

  it("accepts changelog_only review when required artifacts are present", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
      ],
      judgment: {
        stages: { docsReview: { mode: "enforce" } },
      },
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      mergeReady: boolean;
      reviewPath?: string;
      reviewId: string;
      gate: {
        judgmentDecision: Record<string, unknown>;
        judgmentOrchestration: {
          mode: string;
          activeDecision: Record<string, unknown>;
        };
      };
    };
    expect(body.mergeReady).toBe(true);
    expect(body.reviewPath).toBeDefined();
    expect(fs.existsSync(body.reviewPath!)).toBe(true);
    expect(body.reviewId).toMatch(/^review-task-920-/);
    expect(body.gate.judgmentOrchestration.mode).toBe("off");

    const persisted = JSON.parse(fs.readFileSync(body.reviewPath!, "utf-8")) as {
      gate: typeof body.gate;
    };
    expect(persisted.gate.judgmentOrchestration.activeDecision).toEqual(
      persisted.gate.judgmentDecision,
    );

    const eventPath = path.join(projectRoot, ".quack", "logs", `events-${body.reviewId}.jsonl`);
    const events = fs
      .readFileSync(eventPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; payload: Record<string, unknown> });
    expect(events.map((event) => event.stage)).toEqual([
      "judgment_evaluation",
      "judgment_decision",
    ]);
    const decisionEvent = events[1].payload.decision;
    expect(decisionEvent).toEqual(persisted.gate.judgmentOrchestration.activeDecision);
  });

  it("blocks feature_page_update when wiki artifacts are incomplete", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
      ],
    });

    expect(resp.status).toBe(422);
    const body = JSON.parse(resp.body) as { gate: { missingWikiActions: string[] } };
    expect(body.gate.missingWikiActions).toContain("feature_page_update");
  });

  it("flags non-canonical task status values as an advisory without blocking (TASK-1300)", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-921",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-921.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-921"],
          action: "changelog_entry",
        },
      ],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      mergeReady: boolean;
      gate: { issues: Array<{ code: string; blocking: boolean }> };
    };
    expect(body.mergeReady).toBe(true);
    const statusIssue = body.gate.issues.find((issue) => issue.code === "non_canonical_status");
    expect(statusIssue).toBeDefined();
    expect(statusIssue?.blocking).toBe(false);
  });

  it("blocks /api/tasks/:id/verified when linked review is not merge-ready", async () => {
    const reviewResp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
      ],
    });
    expect(reviewResp.status).toBe(422);
    const reviewBody = JSON.parse(reviewResp.body) as { reviewId: string };

    const verifyResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      reviewId: reviewBody.reviewId,
      requireReview: true,
      commit: "abc1234",
    });

    expect(verifyResp.status).toBe(409);
    const verifyBody = JSON.parse(verifyResp.body) as { error: string };
    expect(verifyBody.error).toBe("review_not_merge_ready");
  });

  it("requires review linkage for /verify-task method on VERIFIED verdict", async () => {
    const verifyResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      method: "/verify-task",
      commit: "abc1234",
    });

    expect(verifyResp.status).toBe(409);
    const verifyBody = JSON.parse(verifyResp.body) as { error: string };
    expect(verifyBody.error).toBe("review_required");
  });

  it("returns persisted verification fields on first-time POST", async () => {
    const verifyResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "SOFT-VERIFIED",
      verified: "2026-05-12",
      commit: "abc1111",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 1,
    });

    expect(verifyResp.status).toBe(200);
    const verifyBody = JSON.parse(verifyResp.body) as {
      ok: boolean;
      applied: boolean;
      verdict: string;
      commit: string;
      criteria_checked: number;
      criteria_passed: number;
      persisted: { verdict: string; commit: string };
    };
    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.applied).toBe(true);
    expect(verifyBody.verdict).toBe("SOFT-VERIFIED");
    expect(verifyBody.commit).toBe("abc1111");
    expect(verifyBody.criteria_checked).toBe(2);
    expect(verifyBody.criteria_passed).toBe(1);
    expect(verifyBody.persisted).toMatchObject({
      verdict: "SOFT-VERIFIED",
      commit: "abc1111",
    });

    expect(readVerifiedProjection(projectRoot)["TASK-920"]).toMatchObject({
      verdict: "SOFT-VERIFIED",
      commit: "abc1111",
    });
  });

  it("upgrades an existing row from SOFT-VERIFIED to VERIFIED via repeat POST", async () => {
    const firstResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "SOFT-VERIFIED",
      verified: "2026-05-12",
      commit: "abc1111",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 1,
    });
    expect(firstResp.status).toBe(200);

    const secondResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      verified: "2026-05-13",
      commit: "abc2222",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 2,
    });

    expect(secondResp.status).toBe(200);
    const secondBody = JSON.parse(secondResp.body) as {
      applied: boolean;
      verdict: string;
      commit: string;
      skippedReason: string | null;
    };
    expect(secondBody).toMatchObject({
      applied: true,
      verdict: "VERIFIED",
      commit: "abc2222",
      skippedReason: null,
    });

    expect(readVerifiedProjection(projectRoot)["TASK-920"]).toMatchObject({
      verdict: "VERIFIED",
      commit: "abc2222",
    });
  });

  it("updates an existing row from VERIFIED to FAILED when the later write is newer", async () => {
    const firstResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      verified: "2026-05-12",
      commit: "abc1111",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 2,
    });
    expect(firstResp.status).toBe(200);

    const secondResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "FAILED",
      verified: "2026-05-13",
      commit: "abc3333",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 1,
      notes: "runtime regression found",
    });

    expect(secondResp.status).toBe(200);
    const secondBody = JSON.parse(secondResp.body) as {
      applied: boolean;
      verdict: string;
      commit: string;
      criteria_passed: number;
    };
    expect(secondBody).toMatchObject({
      applied: true,
      verdict: "FAILED",
      commit: "abc3333",
      criteria_passed: 1,
    });

    expect(readVerifiedProjection(projectRoot)["TASK-920"]).toMatchObject({
      verdict: "FAILED",
      commit: "abc3333",
    });
  });

  it("returns conflict metadata when a stale repeat POST does not apply", async () => {
    // Precedence is write-recency (updated_at), not verified-date order
    // (QPI-022). The stale path is reachable only with explicit write
    // cursors, exactly how federation-sync replays peer rows.
    const firstResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      verified: "2026-05-13",
      updated_at: "2026-05-13T10:00:00.000Z",
      commit: "abc9999",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 2,
    });
    expect(firstResp.status).toBe(200);

    const staleResp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "FAILED",
      verified: "2026-05-12",
      updated_at: "2026-05-12T10:00:00.000Z",
      commit: "abc0001",
      method: "api",
      criteria_checked: 2,
      criteria_passed: 1,
      notes: "older evidence",
    });

    expect(staleResp.status).toBe(409);
    const staleBody = JSON.parse(staleResp.body) as {
      ok: boolean;
      error: string;
      skippedReason: string;
      persisted: { verdict: string; commit: string };
    };
    expect(staleBody).toMatchObject({
      ok: false,
      error: "verification_stale_write",
      skippedReason: "stale",
      persisted: {
        verdict: "VERIFIED",
        commit: "abc9999",
      },
    });

    expect(readVerifiedProjection(projectRoot)["TASK-920"]).toMatchObject({
      verdict: "VERIFIED",
      commit: "abc9999",
    });
  });

  it("rejects a malformed updated_at cursor", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      commit: "abc9999",
      method: "api",
      criteria_checked: 1,
      criteria_passed: 1,
      updated_at: "May 13 2026",
    });

    expect(resp.status).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "invalid_updated_at" });
  });

  it("rejects a calendar-rollover updated_at cursor (2026-02-30 parses as Mar 2)", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "VERIFIED",
      commit: "abc9999",
      method: "api",
      criteria_checked: 1,
      criteria_passed: 1,
      updated_at: "2026-02-30T10:00:00Z",
    });

    expect(resp.status).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "invalid_updated_at" });
  });

  it("rejects a future updated_at cursor (poisoned-row guard)", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/api/tasks/TASK-920/verified`, {
      verdict: "FAILED",
      commit: "abc0001",
      method: "api",
      criteria_checked: 1,
      criteria_passed: 0,
      updated_at: "9999-01-01T00:00:00.000Z",
    });

    expect(resp.status).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "updated_at_in_future" });
  });

  it("fetches persisted review bundle by id", async () => {
    const createResp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
      ],
    });
    expect(createResp.status).toBe(201);
    const createBody = JSON.parse(createResp.body) as { reviewId: string };

    const getResp = await httpGet(`http://127.0.0.1:${port}/v1/reviews/${createBody.reviewId}`);
    expect(getResp.status).toBe(200);
    const getBody = JSON.parse(getResp.body) as { review: { taskId: string; reviewId: string } };
    expect(getBody.review.taskId).toBe("TASK-920");
    expect(getBody.review.reviewId).toBe(createBody.reviewId);
  });

  it("lists persisted review bundles", async () => {
    const createResp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      summary: "Queue and operator workflow wiring is complete.",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
      ],
    });
    expect(createResp.status).toBe(201);
    const createBody = JSON.parse(createResp.body) as { reviewId: string };

    const listResp = await httpGet(`http://127.0.0.1:${port}/v1/reviews`);
    expect(listResp.status).toBe(200);
    const listBody = JSON.parse(listResp.body) as {
      reviews: Array<{
        reviewId: string;
        taskId: string;
        verdict: string;
        mergeReady?: boolean;
        summary?: string;
      }>;
    };

    expect(listBody.reviews.length).toBeGreaterThan(0);
    expect(listBody.reviews[0]?.reviewId).toBe(createBody.reviewId);
    expect(listBody.reviews[0]?.taskId).toBe("TASK-920");
    expect(listBody.reviews[0]?.verdict).toBe("VERIFIED");
    expect(listBody.reviews[0]?.mergeReady).toBe(true);
    expect(listBody.reviews[0]?.summary).toBe("Queue and operator workflow wiring is complete.");
  });

  it("returns support-content records for downstream consumers", async () => {
    const createResp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-920",
      verdict: "VERIFIED",
      docsImpact: "support_bundle",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "changelog_entry",
        },
        {
          pagePath: "raw/features/dashboard/ambient-display.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "feature_page_update",
        },
        {
          pagePath: "raw/support/kb/ambient-display.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-920"],
          action: "support_bundle",
        },
      ],
      supportDocCandidates: [
        {
          title: "Ambient Display Guide",
          summary: "How to activate and dismiss ambient mode.",
          productArea: "web-dashboard",
          linkedTaskIds: ["TASK-920"],
          tags: ["ambient", "display"],
        },
      ],
    });
    expect(createResp.status).toBe(201);

    const getResp = await httpGet(
      `http://127.0.0.1:${port}/v1/support-content?taskId=TASK-920&limit=10`,
    );
    expect(getResp.status).toBe(200);
    const body = JSON.parse(getResp.body) as {
      count: number;
      records: Array<{ taskId: string; title: string }>;
    };
    expect(body.count).toBeGreaterThan(0);
    expect(body.records[0]?.taskId).toBe("TASK-920");
    expect(body.records[0]?.title).toBe("Ambient Display Guide");
  });

  it("accepts docs_change_event and persists job event log", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/jobs/JOB-1/events`, {
      eventType: "docs_change_event",
      taskId: "TASK-920",
      payload: {
        docsImpact: "changelog_only",
        requiredWikiActions: ["changelog_entry"],
        wikiArtifacts: [
          {
            pagePath: "raw/platform/changelog/2026-04-26-task-920.md",
            commitSha: "abc1234",
            linkedTaskIds: ["TASK-920"],
          },
        ],
        summary: "Docs updated.",
      },
    });

    expect(resp.status).toBe(202);
    const eventLogPath = path.join(
      projectRoot,
      ".quack",
      "docs-pipeline",
      "job-events",
      "JOB-1.jsonl",
    );
    expect(fs.existsSync(eventLogPath)).toBe(true);
    const content = fs.readFileSync(eventLogPath, "utf-8");
    expect(content).toContain("docs_change_event");
  });
});

// ─── TASK-1203: reviews → verified-ledger bridge ───────────────────────

/** The monitor regenerates an empty verified.json at startup, so "no ledger
 *  write" means "no entry for the task", never "no file". */
function readProjectionSafe(projectRoot: string): Record<string, Record<string, unknown>> {
  try {
    return readVerifiedProjection(projectRoot);
  } catch {
    return {};
  }
}

function changelogArtifact(taskId: string): Record<string, unknown> {
  return {
    pagePath: `raw/platform/changelog/2026-07-14-${taskId.toLowerCase()}.md`,
    commitSha: "wiki1234",
    linkedTaskIds: [taskId],
    action: "changelog_entry",
  };
}

describe("v1 reviews ledger bridge (TASK-1203)", () => {
  let projectRoot: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeTaskFile(projectRoot, "TASK-930", "COMPLETE", true);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    port = started.port;
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(projectRoot);
  });

  it("writes a VERIFIED ledger row (method v1-review) and advances task_status", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "deadbee1234",
      summary: "Verified end to end.",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      ledger?: { applied: boolean; skippedReason?: string };
      reviewId: string;
    };
    expect(body.ledger).toEqual({ applied: true });

    const tasks = readVerifiedProjection(projectRoot);
    expect(tasks["TASK-930"]).toMatchObject({
      verdict: "VERIFIED",
      method: "v1-review",
      commit: "deadbee1234",
      reviewId: body.reviewId,
    });

    // Status advance, read through the TASK-1202 readonly overlay.
    expect(loadStatusOverlay(projectRoot)?.get("TASK-930")).toBe("COMPLETE");
  });

  it("refuses a contested real-DB ledger write before its applied callback effects", async () => {
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", "TASK-930-test.md"),
      path.join(projectRoot, "docs", "tasks", "TASK-999-cross-claimant.md"),
    );
    const projectionPath = path.join(projectRoot, ".quack", "verified.json");
    const projectionBytes = fs.readFileSync(projectionPath);

    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      ledger?: { applied: boolean; skippedReason?: string };
      reviewPath?: string;
    };
    expect(body.ledger).toEqual({ applied: false, skippedReason: "duplicate-claimants" });
    expect(fs.existsSync(body.reviewPath as string)).toBe(true);
    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-930")).toBeUndefined();
      expect(db.getStatus("TASK-930")).toBeUndefined();
    } finally {
      db.close();
    }
    expect(fs.readFileSync(projectionPath)).toEqual(projectionBytes);
  });

  it("preserves the review and reports ledger.error when positive commitSha is omitted", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      reviewPath: string;
      ledger: { applied: boolean; error: string };
    };
    expect(fs.existsSync(body.reviewPath)).toBe(true);
    expect(body.ledger.applied).toBe(false);
    expect(body.ledger.error).toContain("Positive verification requires");
    expect(readProjectionSafe(projectRoot)["TASK-930"]).toBeUndefined();
    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-930")).toBeUndefined();
      expect(db.getVerifiedHistory("TASK-930")).toEqual([]);
      expect(db.getStatus("TASK-930")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("a duplicate review does not churn the existing VERIFIED row", async () => {
    const first = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });
    expect(first.status).toBe(201);

    const second = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "ffffffff999",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(second.status).toBe(201);
    const body = JSON.parse(second.body) as {
      ledger?: { applied: boolean; skippedReason?: string };
    };
    expect(body.ledger).toEqual({ applied: false, skippedReason: "existing-verdict" });
    expect(readVerifiedProjection(projectRoot)["TASK-930"]).toMatchObject({
      commit: "deadbee1234",
    });
  });

  it("a PARTIAL verdict writes nothing", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "PARTIAL",
      docsImpact: "none",
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as { ledger?: unknown };
    expect(body.ledger).toBeUndefined();
    expect(readProjectionSafe(projectRoot)["TASK-930"]).toBeUndefined();
  });

  // TASK-1328 replaced the assertion that used to live here ("a
  // gate-blocked review writes nothing"). It encoded the coupling this
  // task removes: DOCS DEBT blocked the ledger as well as merge-readiness,
  // so a verified task with an outstanding feature page left a
  // healthy-looking review bundle and NO canonical row. Four example rows sat
  // like that on 2026-08-10 while the operator believed they were closed.
  // The 422 is unchanged; what changed is that the fact of verification is
  // now recorded behind it.
  it("a DOCS-blocked review still 422s but DOES write the verified row", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(resp.status).toBe(422);
    const body = JSON.parse(resp.body) as {
      mergeReady: boolean;
      ledger?: { applied: boolean };
    };
    // The gate still says no...
    expect(body.mergeReady).toBe(false);
    // ...and the response no longer implies nothing was recorded.
    expect(body.ledger).toEqual({ applied: true });
    expect(readProjectionSafe(projectRoot)["TASK-930"]).toBeDefined();
  });

  it("TASK-1328: the row carries NO docs-debt breadcrumb", async () => {
    writeTaskFile(projectRoot, "TASK-931", "COMPLETE", true);
    await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-931",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-931")],
    });

    // Round-1 F1: `skipIfExistingVerdict` would make any debt note written
    // here PERMANENT, outliving the debt it describes. The review bundle
    // holds the unmet actions structurally; the row must not.
    const row = readProjectionSafe(projectRoot)["TASK-931"];
    expect(row).toBeDefined();
    const notes = typeof row?.notes === "string" ? row.notes : "";
    expect(notes).not.toMatch(/feature_page_update|requiredWikiActions|missing/i);
  });

  // Round-2 F1: the first version of this test asserted only "integrity
  // blocks write nothing", which PASSED against the pre-fix code too --
  // it would have stayed green even if the bridge regressed all the way
  // back to the blanket mergeReady gate. An assertion that cannot fail
  // against the old behaviour is not evidence of the new one. The
  // partition is a CONTRAST, so the test has to be one: both halves in a
  // single case, asserting they DIVERGE.
  it("TASK-1328: docs debt records, integrity does not - asserted as a contrast", async () => {
    writeTaskFile(projectRoot, "TASK-932", "COMPLETE", true);
    writeTaskFile(projectRoot, "TASK-934", "COMPLETE", true);

    // Docs debt: the work is done, the paperwork is late.
    const docsBlocked = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-934",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-934")],
    });

    // Integrity: the gate REFUTED the claim (an open P1 finding).
    const integrityBlocked = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-932",
      verdict: "VERIFIED",
      docsImpact: "none",
      commitSha: "deadbee1234",
      findings: [{ severity: "P1", title: "open hole", status: "open" }],
    });

    // Both are refused for merge...
    expect(docsBlocked.status).toBe(422);
    expect(integrityBlocked.status).toBe(422);

    // ...and this is the whole point of the task: they DIFFER in the ledger.
    const projection = readProjectionSafe(projectRoot);
    expect(projection["TASK-934"]).toBeDefined();
    expect(projection["TASK-932"]).toBeUndefined();
  });

  it("TASK-1328: 422-with-debt then 201 once the docs land, on the SAME task", async () => {
    writeTaskFile(projectRoot, "TASK-933", "COMPLETE", true);
    const first = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-933",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-933")],
    });
    expect(first.status).toBe(422);
    expect(readProjectionSafe(projectRoot)["TASK-933"]).toBeDefined();

    // Docs land; the same task is re-reviewed with the full artifact set.
    const second = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-933",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      commitSha: "deadbee1234",
      wikiArtifacts: [
        changelogArtifact("TASK-933"),
        { ...changelogArtifact("TASK-933"), action: "feature_page_update" },
      ],
    });
    expect(second.status).toBe(201);
    // The second write is correctly a no-op rather than an error or a
    // downgrade: the row already carries the same verdict.
    const body = JSON.parse(second.body) as {
      ledger?: { applied: boolean; skippedReason?: string };
    };
    expect(body.ledger?.applied).toBe(false);
    expect(body.ledger?.skippedReason).toBe("existing-verdict");
  });

  it("an unknown taskId persists the review but never reaches the ledger", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-999",
      verdict: "VERIFIED",
      docsImpact: "none",
      commitSha: "deadbee1234",
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      reviewPath?: string;
      ledger?: { applied: boolean; skippedReason?: string };
    };
    expect(body.ledger).toEqual({ applied: false, skippedReason: "unknown-task" });
    expect(fs.existsSync(body.reviewPath!)).toBe(true);
    expect(readProjectionSafe(projectRoot)["TASK-999"]).toBeUndefined();
  });

  it("upgrades an existing SOFT-VERIFIED row to VERIFIED", async () => {
    // Seed the on-merge-style row through the canonical writer against the
    // same WAL db the server holds (multi-connection writes are supported).
    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      await recordVerification(
        { projectRoot, db },
        {
          taskId: "TASK-930",
          verdict: "SOFT-VERIFIED",
          commitSha: "ae09eabc123",
          method: "on-merge",
          criteriaChecked: 0,
          criteriaPassed: 0,
        },
      );
    } finally {
      db.close();
    }

    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "deadbee1234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as { ledger?: { applied: boolean } };
    expect(body.ledger).toEqual({ applied: true });
    expect(readVerifiedProjection(projectRoot)["TASK-930"]).toMatchObject({
      verdict: "VERIFIED",
      method: "v1-review",
      commit: "deadbee1234",
    });
  });
});

// ─── TASK-1204: backfill endpoint contract ──────────────────────────────

describe("v1 reviews ledger bridge real downstream state (TASK-1338-F)", () => {
  interface QueueApiItem {
    taskId: string;
    status: string;
    blockedBy: string[];
  }

  let projectRoot: string;
  let logDir: string;
  let port: number;
  let federatedJobId: string;
  let stop: (() => Promise<void>) | null = null;

  async function readQueueItem(taskId: string): Promise<QueueApiItem | undefined> {
    const response = await httpGet(`http://127.0.0.1:${port}/api/queue`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { items: QueueApiItem[] };
    return body.items.find((item) => item.taskId === taskId);
  }

  async function waitForQueueItem(
    taskId: string,
    predicate: (item: QueueApiItem) => boolean,
  ): Promise<QueueApiItem> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const item = await readQueueItem(taskId);
      if (item && predicate(item)) return item;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for queue item ${taskId}`);
  }

  function instrumentCallbackOrder(order: string[]): {
    notifySpy: jest.SpyInstance;
    releaseSpy: jest.SpyInstance;
    tickSpy: jest.SpyInstance;
  } {
    // The unbound original is deliberate: the wrapper reapplies the live queue instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const notifyOriginal = DispatchQueue.prototype.notifyExternalCompletion;
    const releaseOriginal = federationScheduling.releaseFederatedDependencyBlocks;
    const tickOriginal = federationScheduling.runSwarmSchedulerTick;

    const notifySpy = jest
      .spyOn(DispatchQueue.prototype, "notifyExternalCompletion")
      .mockImplementation(async function (this: DispatchQueue, taskId: string): Promise<void> {
        order.push("notify:start");
        await notifyOriginal.call(this, taskId);
        order.push("notify:end");
      });
    const releaseSpy = jest
      .spyOn(federationScheduling, "releaseFederatedDependencyBlocks")
      .mockImplementation(async (...args) => {
        order.push("release:start");
        const result = await releaseOriginal(...args);
        order.push("release:end");
        return result;
      });
    const tickSpy = jest
      .spyOn(federationScheduling, "runSwarmSchedulerTick")
      .mockImplementation(async (...args) => {
        order.push("tick:start");
        const result = await tickOriginal(...args);
        order.push("tick:end");
        return result;
      });
    return { notifySpy, releaseSpy, tickSpy };
  }

  beforeEach(async () => {
    projectRoot = makeTempDir();
    logDir = path.join(projectRoot, ".quack", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    writeTaskFile(projectRoot, "TASK-930", "IN_PROGRESS", true);
    writeTaskFile(projectRoot, "TASK-931", "READY", false, ["TASK-930"]);
    writeTaskFile(projectRoot, "TASK-932", "READY", false, ["TASK-930"]);

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      db.setStatus("TASK-930", "IN_PROGRESS", "real-downstream-fixture");
    } finally {
      db.close();
    }

    new QueuePersistence(logDir).append({
      ts: "2026-08-18T12:00:00.000Z",
      type: "task_enqueued",
      taskId: "TASK-931",
      priority: 2,
      blockedBy: ["TASK-930"],
    });

    const queued = queueFederatedJobRecord({
      taskId: "TASK-932",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance: { channel: "federation-queue", tokenId: "real-state-fixture" },
    });
    const blocked: FederatedJobRecord = {
      ...queued,
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      error: "blocked_by_unresolved:TASK-930",
      nextAction: "wait_for_dependencies",
      decision: { ...queued.decision, dependencyBlockers: ["TASK-930"] },
    };
    await saveFederatedJob(projectRoot, blocked);
    federatedJobId = blocked.jobId;

    await new ListenerRegistry(projectRoot).register({
      hostId: "real-state-host",
      capabilities: ["verify"],
      maxConcurrentJobs: 1,
    });

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir,
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    port = started.port;
    stop = started.stop;

    await waitForQueueItem(
      "TASK-931",
      (item) => item.status === "queued" && item.blockedBy.join(",") === "TASK-930",
    );
    expect(await loadFederatedJob(projectRoot, federatedJobId)).toMatchObject({
      status: "blocked",
      error: "blocked_by_unresolved:TASK-930",
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(projectRoot);
  });

  it("a contested ledger write leaves real local and federation dependents unchanged", async () => {
    const order: string[] = [];
    const { notifySpy, releaseSpy, tickSpy } = instrumentCallbackOrder(order);
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", "TASK-930-test.md"),
      path.join(projectRoot, "docs", "tasks", "TASK-999-cross-claimant.md"),
    );

    const queueBefore = await readQueueItem("TASK-931");
    const queueLogPath = path.join(logDir, "dispatch-queue.jsonl");
    const queueLogBefore = fs.readFileSync(queueLogPath);
    const federationPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${federatedJobId}.json`,
    );
    const federationBefore = fs.readFileSync(federationPath);
    const projectionPath = path.join(projectRoot, ".quack", "verified.json");
    const projectionBefore = fs.readFileSync(projectionPath);
    const beforeDb = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    const statusBefore = beforeDb.getStatus("TASK-930");
    beforeDb.close();
    expect(statusBefore).toBeDefined();

    const response = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "c07e57ed1234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(response.status).toBe(201);
    const body = JSON.parse(response.body) as {
      ledger?: { applied: boolean; skippedReason?: string };
    };
    expect(body.ledger).toEqual({ applied: false, skippedReason: "duplicate-claimants" });
    expect(notifySpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(tickSpy).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(await readQueueItem("TASK-931")).toEqual(queueBefore);
    expect(fs.readFileSync(queueLogPath)).toEqual(queueLogBefore);
    expect(fs.readFileSync(federationPath)).toEqual(federationBefore);
    expect(await loadFederatedJob(projectRoot, federatedJobId)).toMatchObject({
      status: "blocked",
      error: "blocked_by_unresolved:TASK-930",
    });

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-930")).toBeUndefined();
      expect(db.getStatus("TASK-930")).toEqual(statusBefore);
    } finally {
      db.close();
    }
    expect(fs.readFileSync(projectionPath)).toEqual(projectionBefore);
  });

  it("a clean ledger write awaits notify, release, then the conditional scheduler tick", async () => {
    const order: string[] = [];
    const { notifySpy, releaseSpy, tickSpy } = instrumentCallbackOrder(order);
    const queueLogPath = path.join(logDir, "dispatch-queue.jsonl");

    const response = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-930",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "c1ea01234",
      wikiArtifacts: [changelogArtifact("TASK-930")],
    });

    expect(response.status).toBe(201);
    const body = JSON.parse(response.body) as { ledger?: { applied: boolean } };
    expect(body.ledger).toEqual({ applied: true });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "notify:start",
      "notify:end",
      "release:start",
      "release:end",
      "tick:start",
      "tick:end",
    ]);

    expect(await readQueueItem("TASK-931")).toMatchObject({
      taskId: "TASK-931",
      status: "ready",
      blockedBy: [],
    });
    const localEvents = new QueuePersistence(logDir)
      .readEvents()
      .filter((event) => event.taskId === "TASK-931")
      .map((event) => event.type);
    expect(localEvents.slice(-2)).toEqual(["task_unblocked", "task_ready"]);
    expect(fs.readFileSync(queueLogPath, "utf-8")).toContain('"reason":"TASK-930"');

    expect(await loadFederatedJob(projectRoot, federatedJobId)).toMatchObject({
      status: "assigned",
      hostId: "real-state-host",
      lease: { hostId: "real-state-host" },
    });
    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(db.getVerified("TASK-930")).toMatchObject({ verdict: "VERIFIED" });
      expect(db.getStatus("TASK-930")?.status).toBe("COMPLETE");
    } finally {
      db.close();
    }
  });
});

// TASK-1204: backfill endpoint contract.

describe("recording backfill endpoint (TASK-1204)", () => {
  let projectRoot: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeTaskFile(projectRoot, "TASK-950", "COMPLETE", true);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    port = started.port;
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(projectRoot);
  });

  it("rejects a request without a valid since date", async () => {
    const missing = await httpPost(`http://127.0.0.1:${port}/api/recording/backfill`, {});
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toMatchObject({ error: "invalid_backfill_request" });

    const malformed = await httpPost(`http://127.0.0.1:${port}/api/recording/backfill`, {
      since: "last tuesday",
    });
    expect(malformed.status).toBe(400);
  });

  it("refuses to scan a project without an adapter git.baseBranch", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/api/recording/backfill`, {
      since: "2026-05-01",
    });

    expect(resp.status).toBe(400);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "no_base_branch" });
  });
});

// ─── TASK-1203: bridge failure isolation + callback semantics (unit) ───

describe("v1 reviews ledger bridge failure isolation (TASK-1203)", () => {
  async function bootRouteApp(overrides: {
    record?: jest.Mock;
    onLedgerApplied?: jest.Mock;
    db?: unknown;
  }): Promise<{ port: number; close: () => Promise<void>; projectRoot: string }> {
    const projectRoot = makeTempDir();
    writeTaskFile(projectRoot, "TASK-940", "COMPLETE", true);
    const taskPath = path.join(projectRoot, "docs", "tasks", "TASK-940-test.md");

    const app = express();
    app.use(express.json());
    const resolveUnitProject = () => ({
      projectId: "unit",
      projectRoot,
      taskService: {
        getTaskFilePath: (id: string) => Promise.resolve(id === "TASK-940" ? taskPath : null),
        getRawTaskFilePath: () => Promise.resolve(null),
        getTask: () => Promise.resolve(null),
      } as never,
      db: (overrides.db ?? { placeholder: true }) as never,
    });
    registerWorkflowRoutes(app, {
      resolveProject: resolveUnitProject,
      // Single-project unit harness: the write guard resolves without a scope error.
      resolveProjectForWrite: () => ({ ok: true as const, project: resolveUnitProject() }),
      createWorkflowWriter: (() => ({ recordSession: jest.fn(), emit: jest.fn() })) as never,
      resolveAndBroadcastProjection: (() => Promise.resolve(undefined)) as never,
      sse: { broadcast: jest.fn() } as never,
      recordVerification: (overrides.record ??
        jest.fn().mockResolvedValue({ applied: true, row: {} })) as never,
      onLedgerApplied: overrides.onLedgerApplied as never,
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      port,
      projectRoot,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  const payload = {
    taskId: "TASK-940",
    verdict: "VERIFIED",
    docsImpact: "changelog_only",
    commitSha: "deadbee1234",
    wikiArtifacts: [changelogArtifact("TASK-940")],
  };

  it("a throwing store still returns 201 with the review persisted and docs run", async () => {
    const record = jest.fn().mockRejectedValue(new Error("db locked"));
    const boot = await bootRouteApp({ record });
    try {
      const resp = await httpPost(`http://127.0.0.1:${boot.port}/v1/reviews`, payload);
      expect(resp.status).toBe(201);
      const body = JSON.parse(resp.body) as {
        ledger?: { applied: boolean; error?: string };
        reviewPath?: string;
        docsPipeline?: unknown;
      };
      expect(body.ledger).toEqual({ applied: false, error: "db locked" });
      expect(fs.existsSync(body.reviewPath!)).toBe(true);
      expect(body.docsPipeline).toBeDefined();
    } finally {
      await boot.close();
      await cleanupDir(boot.projectRoot);
    }
  });

  it("onLedgerApplied fires once on applied writes and its failure is swallowed", async () => {
    const onLedgerApplied = jest.fn().mockRejectedValue(new Error("release blew up"));
    const boot = await bootRouteApp({ onLedgerApplied });
    try {
      const resp = await httpPost(`http://127.0.0.1:${boot.port}/v1/reviews`, payload);
      expect(resp.status).toBe(201);
      const body = JSON.parse(resp.body) as { ledger?: { applied: boolean } };
      expect(body.ledger).toEqual({ applied: true });
      expect(onLedgerApplied).toHaveBeenCalledTimes(1);
      expect(onLedgerApplied).toHaveBeenCalledWith(expect.anything(), "TASK-940");
    } finally {
      await boot.close();
      await cleanupDir(boot.projectRoot);
    }
  });

  it("awaits the clean applied callback before returning the review response", async () => {
    let releaseCallback: (() => void) | undefined;
    const order: string[] = [];
    const onLedgerApplied = jest.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push("callback-start");
          releaseCallback = () => {
            order.push("callback-end");
            resolve();
          };
        }),
    );
    const record = jest.fn().mockImplementation(() => {
      order.push("record-applied");
      return Promise.resolve({ applied: true, row: {} });
    });
    const boot = await bootRouteApp({ record, onLedgerApplied });
    try {
      let settled = false;
      const responsePromise = httpPost(`http://127.0.0.1:${boot.port}/v1/reviews`, payload).then(
        (response) => {
          settled = true;
          order.push("response");
          return response;
        },
      );
      for (let attempt = 0; attempt < 20 && !releaseCallback; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(order).toEqual(["record-applied", "callback-start"]);
      expect(settled).toBe(false);
      releaseCallback?.();
      const response = await responsePromise;
      expect(response.status).toBe(201);
      expect(order).toEqual(["record-applied", "callback-start", "callback-end", "response"]);
    } finally {
      await boot.close();
      await cleanupDir(boot.projectRoot);
    }
  });

  it("onLedgerApplied never fires on a skipped write", async () => {
    const record = jest.fn().mockResolvedValue({
      applied: false,
      skippedReason: "existing-verdict",
      row: {},
    });
    const onLedgerApplied = jest.fn();
    const boot = await bootRouteApp({ record, onLedgerApplied });
    try {
      const resp = await httpPost(`http://127.0.0.1:${boot.port}/v1/reviews`, payload);
      expect(resp.status).toBe(201);
      const body = JSON.parse(resp.body) as {
        ledger?: { applied: boolean; skippedReason?: string };
      };
      expect(body.ledger).toEqual({ applied: false, skippedReason: "existing-verdict" });
      expect(onLedgerApplied).not.toHaveBeenCalled();
    } finally {
      await boot.close();
      await cleanupDir(boot.projectRoot);
    }
  });
});

describe("advisory status gating feeds the ledger bridge (TASK-1300)", () => {
  let projectRoot: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  function writePlainStatusTaskFile(root: string, taskId: string): void {
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const content = [
      `# ${taskId}: Plain Status Task`,
      "",
      "## Metadata",
      "- **Priority:** P2-MEDIUM",
      "- **Effort:** 1-2 hours",
      "Status: COMPLETE",
      "",
      "## Problem Statement",
      "Manual-loop era spec with a plain status line.",
      "",
      "## Success Criteria",
      "- [x] Criterion 1",
      "",
      "## Testing Requirements",
      "- [x] Test 1",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(taskDir, `${taskId}-plain.md`), content, "utf-8");
  }

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writePlainStatusTaskFile(projectRoot, "TASK-931");
    writeTaskFile(projectRoot, "TASK-932", "VERIFIED", false);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    const started = await server.start();
    port = started.port;
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(projectRoot);
  });

  it("a VERIFIED review of a plain-Status spec is mergeReady and reaches the ledger (was a false 422)", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-931",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "cafebabe123",
      wikiArtifacts: [changelogArtifact("TASK-931")],
    });

    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body) as {
      mergeReady: boolean;
      gate: { issues: Array<{ code: string; blocking: boolean }> };
      ledger?: { applied: boolean };
    };
    expect(body.mergeReady).toBe(true);
    expect(body.gate.issues.filter((i) => i.code === "missing_status")).toHaveLength(0);
    expect(body.ledger).toEqual({ applied: true });
    expect(readVerifiedProjection(projectRoot)["TASK-931"]).toMatchObject({
      verdict: "VERIFIED",
      method: "v1-review",
      commit: "cafebabe123",
    });
  });

  it("a checklist-mismatch VERIFIED claim still 422s and skips the bridge", async () => {
    const resp = await httpPost(`http://127.0.0.1:${port}/v1/reviews`, {
      taskId: "TASK-932",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      commitSha: "cafebabe456",
      wikiArtifacts: [changelogArtifact("TASK-932")],
    });

    expect(resp.status).toBe(422);
    const body = JSON.parse(resp.body) as {
      mergeReady: boolean;
      gate: { issues: Array<{ code: string; blocking: boolean }> };
      ledger?: { applied: boolean };
    };
    expect(body.mergeReady).toBe(false);
    expect(
      body.gate.issues.some((i) => i.code === "verified_unchecked_checklists" && i.blocking),
    ).toBe(true);
    expect(body.ledger).toBeUndefined();
    expect(readProjectionSafe(projectRoot)["TASK-932"]).toBeUndefined();
  });
});
