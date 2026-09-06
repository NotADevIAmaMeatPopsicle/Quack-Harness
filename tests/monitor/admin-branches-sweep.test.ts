// ─── Admin branches sweep API tests ──────────────────────────────────
// Tests for POST /api/admin/branches/sweep

import * as http from "node:http";

import express from "express";

import type { SweepReport } from "../../src/dispatcher/branch-manager";
import { registerAdminRoutes } from "../../src/monitor/routes/admin";

// ─── Mock branch-manager and adapter-loader ───────────────────────────

const mockSweep = jest.fn<
  Promise<SweepReport>,
  Parameters<typeof import("../../src/dispatcher/branch-manager").sweep>
>();
const mockLoadAdapter = jest.fn();

jest.mock("../../src/dispatcher/branch-manager", () => ({
  sweep: (...args: Parameters<typeof mockSweep>) => mockSweep(...args),
}));

jest.mock("../../src/core/adapter-loader", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  loadAdapter: (projectRoot: string) => mockLoadAdapter(projectRoot),
}));

// ─── Server helpers ──────────────────────────────────────────────────

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function httpPost(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // leave empty
  }
  return { status: response.status, body: parsed };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function makeReport(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    dryRun: true,
    baseBranch: "main",
    scanned: 0,
    policy: {
      enabled: true,
      retentionDays: 1,
      allowedPrefixes: ["quack/TASK-"],
      protectedOwners: ["contributor"],
      protectedPatterns: ["contributor/**", "*/contributor/**"],
      requireOwnerOverride: true,
    },
    candidates: [],
    deleted: [],
    skipped: [],
    errors: [],
    durationMs: 42,
    ...overrides,
  };
}

function makeApp(projectRoot: string | undefined): express.Express {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, {
    resolveProject: () => ({ projectRoot, projectId: "test" }),
  });
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("POST /api/admin/branches/sweep", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(() => {
    mockSweep.mockReset();
    mockLoadAdapter.mockReset();
    // Default adapter mock
    mockLoadAdapter.mockResolvedValue({
      config: { git: { baseBranch: "main" } },
      projectRoot: "/fake/project",
    });
  });

  afterEach(async () => {
    if (server) {
      await close(server);
    }
  });

  test("missing dryRun defaults to true", async () => {
    const report = makeReport({ dryRun: true });
    mockSweep.mockResolvedValue(report);

    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, {});

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true }),
      expect.anything(),
    );
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  test("dryRun: true returns report without deleting", async () => {
    const report = makeReport({
      dryRun: true,
      deleted: ["quack/TASK-1", "quack/TASK-2"],
    });
    mockSweep.mockResolvedValue(report);

    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, { dryRun: true });

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect((res.body as { report: SweepReport }).report.dryRun).toBe(true);
    expect((res.body as { report: SweepReport }).report.deleted).toHaveLength(2);
  });

  test("dryRun: false calls sweep with dryRun: false", async () => {
    const report = makeReport({ dryRun: false, deleted: ["quack/TASK-1"] });
    mockSweep.mockResolvedValue(report);

    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, { dryRun: false });

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: false }),
      expect.anything(),
    );
  });

  test("invalid body returns 400", async () => {
    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, { dryRun: "yes" });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Invalid request body");
  });

  test("baseBranch override is forwarded to sweep", async () => {
    const report = makeReport({ baseBranch: "main" });
    mockSweep.mockResolvedValue(report);

    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, {
      dryRun: true,
      baseBranch: "main",
    });

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseBranch: "main" }),
      expect.anything(),
    );
  });

  test("forwards cleanup policy and protected-owner override options", async () => {
    const report = makeReport({
      dryRun: true,
      scanned: 1,
      skipped: [
        {
          branch: "contributor/task-123",
          reason: "protected-owner",
          owner: "contributor",
          requiresOverride: true,
        },
      ],
    });
    mockSweep.mockResolvedValue(report);

    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, {
      dryRun: true,
      allowedPrefixes: ["quack/TASK-", "echo/TASK-", "contributor/"],
      protectedOwners: ["contributor"],
      protectedPatterns: ["contributor/**", "*/contributor/**"],
      ownerOverride: {
        owner: "contributor",
        reason: "Explicit cleanup approval from Operator.",
      },
    });

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dryRun: true,
        allowedPrefixes: ["quack/TASK-", "echo/TASK-", "contributor/"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        ownerOverride: {
          owner: "contributor",
          reason: "Explicit cleanup approval from Operator.",
        },
      }),
      expect.anything(),
    );
    expect((res.body as { report: SweepReport }).report.skipped).toEqual([
      expect.objectContaining({
        branch: "contributor/task-123",
        reason: "protected-owner",
        owner: "contributor",
        requiresOverride: true,
      }),
    ]);
  });

  test("rejects protected-owner override without a reason", async () => {
    const app = makeApp("/fake/project");
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, {
      dryRun: false,
      ownerOverride: {
        owner: "contributor",
      },
    });

    expect(res.status).toBe(400);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  test("missing project root returns 404", async () => {
    const app = makeApp(undefined);
    ({ server, baseUrl } = await listen(app));

    const res = await httpPost(`${baseUrl}/api/admin/branches/sweep`, { dryRun: true });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("Project root not configured");
  });
});
