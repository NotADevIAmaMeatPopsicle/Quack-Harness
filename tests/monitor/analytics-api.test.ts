import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

// Prevent tests from picking up real .quack/auth.json (which has users → auth enabled)
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-analytics-"));
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function writeAnalyticsData(projectRoot: string): void {
  const analyticsDir = path.join(projectRoot, ".quack", "analytics");
  fs.mkdirSync(analyticsDir, { recursive: true });
  const analyticsData = {
    updatedAt: "2026-01-15T10:00:00.000Z",
    totalRuns: 50,
    totalApproved: 35,
    totalRejected: 12,
    totalErrors: 3,
    byTag: {
      api: { runs: 20, approved: 16, rejected: 3, rate: 0.8 },
      refactor: { runs: 15, approved: 8, rejected: 5, rate: 0.533 },
      testing: { runs: 10, approved: 9, rejected: 1, rate: 0.9 },
    },
    byFile: {
      "src/monitor/server.ts": { runs: 12, approved: 8, rejected: 4, rate: 0.667 },
      "src/core/types.ts": { runs: 8, approved: 7, rejected: 1, rate: 0.875 },
      "tests/monitor/server.test.ts": { runs: 5, approved: 5, rejected: 0, rate: 1.0 },
    },
    byComplexity: {
      simple: { runs: 15, approved: 13, rejected: 2, rate: 0.867 },
      medium: { runs: 25, approved: 18, rejected: 7, rate: 0.72 },
      complex: { runs: 10, approved: 4, rejected: 3, rate: 0.4 },
    },
    byGateScore: {},
    topFeedbackThemes: [{ theme: "missing tests", count: 8 }],
    knownPatterns: [
      {
        pattern: "tag_cluster:refactor",
        description: "Refactor tasks fail more often",
        occurrences: 5,
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-15T00:00:00.000Z",
        suggestion: "Add more detailed specs for refactoring tasks",
      },
    ],
  };
  fs.writeFileSync(
    path.join(analyticsDir, "failure-patterns.json"),
    JSON.stringify(analyticsData, null, 2),
    "utf-8",
  );
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Analytics API", () => {
  let logDir: string;
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<number> {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
    });
    const started = await serverObj.start();
    stopServer = started.stop;
    return started.port;
  }

  it("GET /api/analytics/summary vs /api/analytics/patterns return different shapes", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    // Get summary
    const summaryRes = await httpGet(`http://127.0.0.1:${port}/api/analytics/summary`);
    expect(summaryRes.status).toBe(200);
    const summary = JSON.parse(summaryRes.body) as Record<string, unknown>;

    // Get patterns
    const patternsRes = await httpGet(`http://127.0.0.1:${port}/api/analytics/patterns`);
    expect(patternsRes.status).toBe(200);
    const patterns = JSON.parse(patternsRes.body) as Record<string, unknown>;

    // Summary should have aggregate stats with successRate
    expect(summary.totalRuns).toBe(50);
    expect(summary.successRate).toBeDefined();
    expect(summary.topPatterns).toBeDefined();

    // Patterns should have full DB with byTag, byFile, knownPatterns
    expect(patterns.totalRuns).toBe(50);
    expect(patterns.byTag).toBeDefined();
    expect(patterns.byFile).toBeDefined();
    expect(patterns.knownPatterns).toBeDefined();

    // They should be different shapes (summary has successRate, patterns has byTag)
    expect(summary.byTag).toBeUndefined();
    expect(patterns.successRate).toBeUndefined();
  });

  it("GET /api/analytics/by-tag with valid tag returns filtered results", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/analytics/by-tag?tag=api`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { tag: string; data: { runs: number; rate: number } };
    expect(data.tag).toBe("api");
    expect(data.data.runs).toBe(20);
    expect(data.data.rate).toBe(0.8);
  });

  it("GET /api/analytics/by-tag returns all tags when no filter", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/analytics/by-tag`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, { runs: number }>;
    expect(data.api).toBeDefined();
    expect(data.refactor).toBeDefined();
    expect(data.testing).toBeDefined();
  });

  it("GET /api/analytics/by-tag returns null data for unknown tag", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/api/analytics/by-tag?tag=nonexistent`,
    );
    expect(status).toBe(200);

    const data = JSON.parse(body) as { tag: string; data: null };
    expect(data.tag).toBe("nonexistent");
    expect(data.data).toBeNull();
  });

  it("GET /api/analytics/by-file with valid file returns filtered results", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(
      `http://127.0.0.1:${port}/api/analytics/by-file?file=${encodeURIComponent("src/monitor/server.ts")}`,
    );
    expect(status).toBe(200);

    const data = JSON.parse(body) as { file: string; data: { runs: number; rate: number } };
    expect(data.file).toBe("src/monitor/server.ts");
    expect(data.data.runs).toBe(12);
    expect(data.data.rate).toBeCloseTo(0.667, 2);
  });

  it("GET /api/analytics/by-file returns all files when no filter", async () => {
    writeAnalyticsData(projectRoot);

    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/analytics/by-file`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as Record<string, { runs: number }>;
    expect(data["src/monitor/server.ts"]).toBeDefined();
    expect(data["src/core/types.ts"]).toBeDefined();
  });

  it("GET /api/analytics/summary returns empty stats when no analytics data", async () => {
    const port = await startServer();

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/api/analytics/summary`);
    expect(status).toBe(200);

    const data = JSON.parse(body) as { totalRuns: number; successRate: number };
    expect(data.totalRuns).toBe(0);
    expect(data.successRate).toBe(0);
  });
});
