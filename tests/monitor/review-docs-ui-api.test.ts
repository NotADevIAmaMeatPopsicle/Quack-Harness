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
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-review-docs-ui-"));
}

function writeTaskFile(projectRoot: string, taskId: string, status = "COMPLETE"): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, `${taskId}-fixture.md`),
    [
      `# ${taskId}: Review Docs Fixture`,
      "",
      "## Metadata",
      "- **Priority:** P1-HIGH",
      "- **Effort:** 1-2 hours",
      `- **Status:** ${status}`,
      "- **Tags:** federated, docs",
      "",
      "## Problem Statement",
      "Fixture task.",
      "",
      "## Current State",
      "Fixture state.",
      "",
      "## Recommended Approach",
      "Exercise review docs summary API.",
      "",
      "## Files to Modify",
      "| File | Action | Notes |",
      "|------|--------|-------|",
      "| `src/monitor/server.ts` | Modify | Fixture |",
      "",
      "## Success Criteria",
      "- [x] Review docs summary returns canonical projection parity",
      "",
      "## Testing Requirements",
      "- [x] API test passes",
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
        lastRefreshedAt: "2026-04-26T12:00:00.000Z",
        lastFetchedDate: "20260426",
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeVerifiedFixture(
  projectRoot: string,
  taskId: string,
  overrides?: Partial<{
    verified: string;
    method: string;
    verdict: string;
    criteriaChecked: number;
    criteriaPassed: number;
    notes: string;
  }>,
): void {
  const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
  fs.mkdirSync(path.dirname(verifiedPath), { recursive: true });
  fs.writeFileSync(
    verifiedPath,
    JSON.stringify(
      {
        version: 1,
        tasks: {
          [taskId]: {
            verified: overrides?.verified ?? "2026-04-26",
            commit: "abc123",
            method: overrides?.method ?? "verify-task",
            verdict: overrides?.verdict ?? "VERIFIED",
            criteriaChecked: overrides?.criteriaChecked ?? 6,
            criteriaPassed: overrides?.criteriaPassed ?? 6,
            notes: overrides?.notes ?? "Fixture verification entry.",
          },
        },
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
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
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

describe("review/docs UI summary API", () => {
  let projectRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-839");

    const port = 48000 + Math.floor(Math.random() * 1000);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
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
  });

  it("returns canonical pending review/docs fields for blocked review gates", async () => {
    const reviewResp = await httpPost(`${baseUrl}/v1/reviews`, {
      taskId: "TASK-839",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-839.md",
          commitSha: "abc123",
          linkedTaskIds: ["TASK-839"],
          action: "changelog_entry",
        },
      ],
    });
    expect(reviewResp.status).toBe(422);

    const summaryResp = await httpGet(`${baseUrl}/v1/tasks/TASK-839/review-docs-summary`);
    expect(summaryResp.status).toBe(200);
    const body = JSON.parse(summaryResp.body) as {
      projection: { state: string; blockReasonCode?: string; missingWikiActions: string[] };
      pendingState: { code: string; label: string } | null;
      verification: { verified: boolean; verdict: string | null };
      closeoutState: {
        mergeReady: boolean;
        docsReady: boolean;
        verified: boolean;
        missingWikiActions: string[];
      };
      reviewGate: {
        mergeReady: boolean;
        missingWikiActions: string[];
        blockingReasons: Array<{ blockReasonCode: string }>;
      };
      docsPipeline: {
        changelog: { present: boolean };
        featureDocs: { required: boolean; present: boolean };
      };
    };

    expect(body.projection.state).toBe("blocked");
    expect(body.projection.blockReasonCode).toBe("pending_wiki_artifacts");
    expect(body.pendingState).toEqual({
      code: "pending_wiki_artifacts",
      label: "Pending wiki artifacts",
    });
    // TASK-1328: a DOCS-blocked review is now VERIFIED-and-recorded while
    // still not merge-ready. This expectation used to assert the coupling
    // the task removes. Note the surface already modelled the two facts
    // separately - `closeoutState` carries mergeReady, docsReady and
    // verified as three distinct fields - so nothing here needed widening,
    // only the test's belief that they always agreed.
    expect(body.verification).toMatchObject({
      verified: true,
      verdict: "VERIFIED",
    });
    // The three facts now differ, which is the whole point of TASK-1328:
    // the work IS verified, the docs are NOT ready, and it is therefore NOT
    // merge-ready. A surface that could only say "all three agree" was
    // hiding the case the operator most needed to see.
    expect(body.closeoutState).toMatchObject({
      mergeReady: false,
      docsReady: false,
      verified: true,
      missingWikiActions: ["feature_page_update"],
    });
    expect(body.reviewGate.mergeReady).toBe(false);
    expect(body.reviewGate.missingWikiActions).toContain("feature_page_update");
    expect(body.reviewGate.blockingReasons[0]?.blockReasonCode).toBe("pending_wiki_artifacts");
    expect(body.docsPipeline.changelog.present).toBe(true);
    expect(body.docsPipeline.featureDocs).toMatchObject({ required: true, present: false });
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "workflow-projections", "TASK-839.json")),
    ).toBe(false);
  });

  it("surfaces docs pipeline artifact and support-content counts for merge-ready tasks", async () => {
    const reviewResp = await httpPost(`${baseUrl}/v1/reviews`, {
      taskId: "TASK-839",
      verdict: "VERIFIED",
      docsImpact: "support_bundle",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-839.md",
          commitSha: "abc123",
          linkedTaskIds: ["TASK-839"],
          action: "changelog_entry",
        },
        {
          pagePath: "raw/features/federated-ui.md",
          commitSha: "abc123",
          linkedTaskIds: ["TASK-839"],
          action: "feature_page_update",
        },
        {
          pagePath: "raw/support/federated-ui.md",
          commitSha: "abc123",
          linkedTaskIds: ["TASK-839"],
          action: "support_bundle",
        },
      ],
      supportDocCandidates: [
        {
          title: "Federated UI pending states",
          summary: "How operators interpret pending federated workflow states.",
          productArea: "quack-monitor",
        },
      ],
    });
    expect(reviewResp.status).toBe(201);
    writeVerifiedFixture(projectRoot, "TASK-839");

    const summaryResp = await httpGet(`${baseUrl}/v1/tasks/TASK-839/review-docs-summary`);
    expect(summaryResp.status).toBe(200);
    const body = JSON.parse(summaryResp.body) as {
      projection: { state: string; mergeReady: boolean };
      verification: {
        verified: boolean;
        verifiedAt: string | null;
        method: string | null;
        verdict: string | null;
        criteriaChecked: number | null;
        criteriaPassed: number | null;
      };
      closeoutState: {
        workflowState: string;
        mergeReady: boolean;
        docsReady: boolean;
        verified: boolean;
      };
      reviewGate: { mergeReady: boolean; requiredWikiActions: string[] };
      docsPipeline: {
        changelog: { present: boolean };
        featureDocs: { present: boolean };
        supportContent: { present: boolean; count: number; records: Array<{ title: string }> };
      };
    };

    expect(body.projection.state).toBe("merge_ready");
    expect(body.closeoutState).toMatchObject({
      workflowState: "merge_ready",
      mergeReady: true,
      docsReady: true,
      verified: true,
    });
    expect(body.verification).toEqual({
      verified: true,
      verifiedAt: "2026-04-26",
      method: "verify-task",
      verdict: "VERIFIED",
      criteriaChecked: 6,
      criteriaPassed: 6,
    });
    expect(body.reviewGate.mergeReady).toBe(true);
    expect(body.reviewGate.requiredWikiActions).toEqual([
      "changelog_entry",
      "feature_page_update",
      "support_bundle",
    ]);
    expect(body.docsPipeline.changelog.present).toBe(true);
    expect(body.docsPipeline.featureDocs.present).toBe(true);
    expect(body.docsPipeline.supportContent.present).toBe(true);
    expect(body.docsPipeline.supportContent.count).toBe(1);
    expect(body.docsPipeline.supportContent.records[0]?.title).toBe("Federated UI pending states");
    expect(
      fs.existsSync(path.join(projectRoot, ".quack", "workflow-projections", "TASK-839.json")),
    ).toBe(false);
  });
});

describe("review/docs monitor UI surface", () => {
  const htmlPath = path.join(__dirname, "..", "..", "src", "monitor", "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  it("renders federated pending-state badges from canonical projection data", () => {
    expect(html).toContain("function renderWorkflowBadge(summary)");
    expect(html).toContain("pending_wiki_artifacts");
    expect(html).toContain("pending_remote_listener");
    expect(html).toContain("workflow_projection_updated");
    expect(html).toContain("workflow_pending_state");
  });

  it("loads the review/docs summary endpoint for task detail panels", () => {
    expect(html).toContain("/v1/tasks/${encodeURIComponent(taskId)}/review-docs-summary");
    expect(html).toContain("function renderWorkflowPanel(summary)");
    expect(html).toContain("Review Gate");
    expect(html).toContain("Support Content");
  });

  it("shows workflow visibility in task rows and active host rows", () => {
    expect(html).toContain("<th>Workflow</th>");
    expect(html).toContain("workflow-row-cell");
    expect(html).toContain("const laneBadge = projection?.lane");
  });
});
