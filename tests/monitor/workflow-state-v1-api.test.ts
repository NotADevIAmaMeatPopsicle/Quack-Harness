import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-workflow-state-api-"));
}

function writeTaskFile(projectRoot: string, taskId: string, status: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = [
    `# ${taskId}: Workflow Projection Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "",
    "## Problem Statement",
    "Projection fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project it.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/workflow/state-projector.ts` | Modify | Fixture |",
    "",
    "## Success Criteria",
    "- [x] Projection returns state",
    "",
    "## Testing Requirements",
    "- [x] API test passes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
}

function writeReviewFixture(projectRoot: string, taskId: string): void {
  const reviewsDir = path.join(projectRoot, ".quack", "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  const reviewId = `review-${taskId.toLowerCase()}`;
  fs.writeFileSync(
    path.join(reviewsDir, "latest-by-task.json"),
    JSON.stringify({ [taskId]: reviewId }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(reviewsDir, `${reviewId}.json`),
    JSON.stringify(
      {
        taskId,
        verdict: "VERIFIED",
        docsImpact: "feature_page_update",
        requiredWikiActions: ["changelog_entry", "feature_page_update"],
        wikiArtifacts: [],
        reviewId,
        createdAt: "2026-04-26T12:00:00.000Z",
        gate: {
          mergeReady: false,
          requiredWikiActions: ["changelog_entry", "feature_page_update"],
          missingWikiActions: ["feature_page_update"],
          issues: [
            {
              code: "missing_wiki_artifacts",
              blockReasonCode: "pending_wiki_artifacts",
              message: "Missing feature page.",
              blocking: true,
              field: "wikiArtifacts",
            },
          ],
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
        path: urlObj.pathname,
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
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
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

describe("GET /v1/tasks/:id/workflow-state", () => {
  let projectRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;
  let broadcastSpy: jest.SpyInstance;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-842", "READY");
    writeTaskFile(projectRoot, "TASK-843", "COMPLETE");
    writeReviewFixture(projectRoot, "TASK-843");

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      port: 0,
      host: "127.0.0.1",
    });
    broadcastSpy = jest.spyOn(server.sse, "broadcast");
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
    await pause(150);
    broadcastSpy.mockClear();
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await pause(150);
    broadcastSpy.mockRestore();
    await cleanupDir(projectRoot);
  });

  it("returns canonical projection payloads without persisting or broadcasting on GET", async () => {
    broadcastSpy.mockClear();
    const resp = await httpGet(`${baseUrl}/v1/tasks/TASK-842/workflow-state`);

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      taskId: string;
      state: string;
      mergeReady: boolean;
      evidenceBundle: { taskId: string };
    };
    expect(body.taskId).toBe("TASK-842");
    expect(body.state).toBe("submitted");
    expect(body.mergeReady).toBe(false);
    expect(body.evidenceBundle.taskId).toBe("TASK-842");
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "workflow-projections", "TASK-842.json")),
    ).toBe(false);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("refresh endpoint persists and broadcasts the resolved projection", async () => {
    broadcastSpy.mockClear();
    const resp = await httpPost(`${baseUrl}/v1/tasks/TASK-842/workflow-state/refresh`, {});

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      ok: boolean;
      taskId: string;
      projection: { taskId: string; state: string; mergeReady: boolean };
      refreshedAt: string;
    };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBe("TASK-842");
    expect(body.projection.taskId).toBe("TASK-842");
    expect(body.projection.state).toBe("submitted");
    expect(body.projection.mergeReady).toBe(false);
    expect(typeof body.refreshedAt).toBe("string");
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "workflow-projections", "TASK-842.json")),
    ).toBe(true);
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "workflow_projection_updated",
        taskId: "TASK-842",
      }),
    );
  });

  it("refresh endpoint emits pending-state SSE for blocked workflow projections", async () => {
    broadcastSpy.mockClear();
    const resp = await httpPost(`${baseUrl}/v1/tasks/TASK-843/workflow-state/refresh`, {});

    expect(resp.status).toBe(200);
    const broadcastCalls = broadcastSpy.mock.calls as Array<
      [
        {
          stage?: string;
          taskId?: string;
          payload?: { blockReasonCode?: string };
        },
      ]
    >;
    const pendingCall = broadcastCalls.find((call) => {
      const event = call[0];
      return event?.stage === "workflow_pending_state";
    });
    expect(pendingCall).toBeDefined();
    if (!pendingCall) {
      throw new Error("Expected workflow_pending_state broadcast");
    }
    const pendingEvent = pendingCall[0];
    expect(pendingEvent.taskId).toBe("TASK-843");
    expect(pendingEvent.payload?.blockReasonCode).toBe("pending_wiki_artifacts");
  });

  it("returns canonical blocked reason fields for review/docs blockers", async () => {
    const resp = await httpGet(`${baseUrl}/v1/tasks/TASK-843/workflow-state`);

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      state: string;
      blockReasonCode: string;
      missingWikiActions: string[];
    };
    expect(body.state).toBe("blocked");
    expect(body.blockReasonCode).toBe("pending_wiki_artifacts");
    expect(body.missingWikiActions).toEqual(["feature_page_update"]);
  });

  it("returns a structured not-found response", async () => {
    const resp = await httpGet(`${baseUrl}/v1/tasks/TASK-999/workflow-state`);

    expect(resp.status).toBe(404);
    expect(JSON.parse(resp.body)).toEqual({
      error: "task_not_found",
      message: "Task TASK-999 not found.",
      taskId: "TASK-999",
    });
  });
});
