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
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-workflows-v1-api-"));
}

function writeTaskFile(projectRoot: string, taskId: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = [
    `# ${taskId}: Workflow API Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    "- **Status:** READY",
    "- **Tags:** [workflow, api]",
    "",
    "## Problem Statement",
    "Workflow fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project workflow events.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/workflows/verify-orchestrator.ts` | Create | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Workflow API returns deterministic results",
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
  data: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
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
    req.write(postData);
    req.end();
  });
}

describe("v1 workflow API", () => {
  let projectRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-837");

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
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
  });

  it("runs verify workflow and persists a queryable record", async () => {
    const resp = await httpPost(`${baseUrl}/v1/workflows/verify`, {
      taskId: "TASK-837",
    });

    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      verdict: string;
      workflowId: string;
      projection: { state: string; workflowId: string };
    };
    expect(body.verdict).toBe("VERIFIED");
    expect(body.projection).toMatchObject({
      state: "verified",
      workflowId: body.workflowId,
    });

    const fetched = await httpGet(`${baseUrl}/v1/workflows/${body.workflowId}`);
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toMatchObject({
      ok: true,
      workflowId: body.workflowId,
      record: { status: "completed", state: "verified" },
    });
  });

  it("blocks verify workflow when required review linkage is missing", async () => {
    const resp = await httpPost(`${baseUrl}/v1/workflows/verify`, {
      taskId: "TASK-837",
      requireReview: true,
    });

    expect(resp.status).toBe(409);
    const body = JSON.parse(resp.body) as {
      verdict: string;
      record: { blockReasonCode: string };
      projection: { state: string; blockReasonCode: string };
    };
    expect(body.verdict).toBe("BLOCKED");
    expect(body.record.blockReasonCode).toBe("review_linkage_required");
    expect(body.projection).toMatchObject({
      state: "blocked",
      blockReasonCode: "review_linkage_required",
    });
  });

  it("records a completed fix workflow attempt", async () => {
    const resp = await httpPost(`${baseUrl}/v1/workflows/fix`, {
      taskId: "TASK-837",
      failureContext: { issues: ["Missing docs"] },
      fixed: true,
    });

    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body)).toMatchObject({
      exhausted: false,
      attempt: { attempt: 1, status: "fixed" },
      projection: { state: "verify_fix" },
    });
  });

  it("escalates fix workflow after the configured attempt cap", async () => {
    const first = await httpPost(`${baseUrl}/v1/workflows/fix`, {
      taskId: "TASK-837",
      failureContext: { issues: ["Still failing"] },
      maxAttempts: 2,
    });
    const firstBody = JSON.parse(first.body) as { workflowId: string };

    const second = await httpPost(`${baseUrl}/v1/workflows/fix`, {
      taskId: "TASK-837",
      workflowId: firstBody.workflowId,
      failureContext: { issues: ["Still failing"] },
      maxAttempts: 2,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({
      exhausted: true,
      record: {
        state: "blocked",
        blockReasonCode: "workflow_attempts_exhausted",
      },
      projection: {
        state: "blocked",
        blockReasonCode: "workflow_attempts_exhausted",
      },
    });
  });
});
