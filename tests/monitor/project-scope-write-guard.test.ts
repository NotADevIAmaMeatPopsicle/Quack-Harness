// ─── TASK-1301: explicit project scope on ledger-writing endpoints ──
// On a multi-project registry, write routes refuse to default to the
// active project (PROJECT_SCOPE_REQUIRED); single-project mode and read
// routes are untouched; scoped writes land on the named project only.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";
import { hashPassword } from "../../src/monitor/auth";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-scope-guard-"));
}

function makeMinimalAdapterConfig(projectName: string, projectRoot: string): AdapterConfig {
  return {
    version: "1.0.0",
    project: {
      name: projectName,
      root: projectRoot,
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-opus-4-20250514",
      judgeModel: "claude-sonnet-4-20250514",
      enrichModel: "claude-sonnet-4-20250514",
      maxTurns: 30,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: { commands: [], conventionChecks: [] },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      branchPrefix: "quack",
      baseBranch: "main",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "info", retainDays: 30 },
  } as AdapterConfig;
}

function setupProjectDirectory(projectRoot: string, projectName: string): void {
  const quackDir = path.join(projectRoot, ".quack");
  fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(quackDir, "adapter.json"),
    JSON.stringify(makeMinimalAdapterConfig(projectName, projectRoot), null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");
}

function writeTaskFile(projectRoot: string, taskId: string): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const content = [
    `# ${taskId}: Scope guard fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1 hour",
    "- **Status:** COMPLETE",
    "",
    "## Problem Statement",
    "Fixture.",
    "",
    "## Success Criteria",
    "- [x] Done",
    "",
    "## Testing Requirements",
    "- [x] Done",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
}

function makeAdapters(roots: string[]): ProjectAdapter[] {
  return roots.map((root, index) => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "adapter.json"), "utf-8"),
    ) as AdapterConfig;
    const config: AdapterConfig = {
      ...raw,
      judgment: {
        runner: {
          provider: "claude-sdk",
          model: "test-model",
          maxTurns: 5,
          timeoutMs: 1_000,
        },
        stages: {
          docsReview: { mode: index === 0 ? "enforce" : "shadow" },
          readiness: { mode: "off" },
          loopBrief: { mode: "off" },
          loopDiff: { mode: "off" },
          judge: { mode: "off" },
        },
      },
    };
    return {
      projectRoot: root,
      config,
      conventionsDoc: "",
      judgeCriteria: "",
      conventionCheckScripts: [],
      adrDocs: {},
      adapterBundle: {
        authority: "local",
        sharedHash: "test-shared-hash",
        normalizedConfig: config,
        machineLocalFields: [],
      },
    };
  });
}

async function httpGet(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
  headers?: Record<string, string>,
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
          ...(headers ?? {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function httpDelete(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "DELETE",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
}

interface ScopeErrorBody {
  code?: string;
  projects?: string[];
  hint?: string;
  error?: string;
}

describe("project scope write guard (TASK-1301) — multi-project registry", () => {
  let rootAlpha: string;
  let rootBeta: string;
  let idAlpha: string;
  let idBeta: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    rootAlpha = makeTempDir();
    rootBeta = makeTempDir();
    setupProjectDirectory(rootAlpha, "alpha");
    setupProjectDirectory(rootBeta, "beta");
    writeTaskFile(rootAlpha, "TASK-777");
    writeTaskFile(rootBeta, "TASK-777"); // deliberate cross-project id collision

    port = 43000 + Math.floor(Math.random() * 2000);
    const server = createMonitorServer({
      port,
      projectAdapters: makeAdapters([rootAlpha, rootBeta]),
    });
    const started = await server.start();
    stop = started.stop;

    const projectsRes = await httpGet(`http://localhost:${port}/api/projects`);
    const projects = JSON.parse(projectsRes.body) as Array<{ id: string; name: string }>;
    idAlpha = projects.find((p) => p.name === "alpha")?.id ?? "alpha";
    idBeta = projects.find((p) => p.name === "beta")?.id ?? "beta";
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(rootAlpha);
    await cleanupDir(rootBeta);
  });

  const expectScopeError = (status: number, body: string): void => {
    expect(status).toBe(400);
    const parsed = JSON.parse(body) as ScopeErrorBody;
    expect(parsed.code).toBe("PROJECT_SCOPE_REQUIRED");
    expect(parsed.projects).toEqual(expect.arrayContaining([idAlpha, idBeta]));
    expect(parsed.hint).toContain("project");
  };

  it("rejects an unscoped POST /v1/reviews", async () => {
    const resp = await httpPost(`http://localhost:${port}/v1/reviews`, {
      taskId: "TASK-777",
      verdict: "VERIFIED",
      docsImpact: "none",
    });
    expectScopeError(resp.status, resp.body);
  });

  it("rejects an unscoped POST /api/recording/scan-now", async () => {
    const resp = await httpPost(`http://localhost:${port}/api/recording/scan-now`, {});
    expectScopeError(resp.status, resp.body);
  });

  it("rejects an unscoped POST /api/recording/backfill (valid body)", async () => {
    const resp = await httpPost(`http://localhost:${port}/api/recording/backfill`, {
      since: "2026-07-01",
    });
    expectScopeError(resp.status, resp.body);
  });

  it("rejects an unscoped POST /api/tasks/:id/reject", async () => {
    const resp = await httpPost(`http://localhost:${port}/api/tasks/TASK-777/reject`, {
      reason: "test",
    });
    expectScopeError(resp.status, resp.body);
  });

  it("rejects an unscoped POST /api/tasks/:id/verified", async () => {
    const resp = await httpPost(`http://localhost:${port}/api/tasks/TASK-777/verified`, {
      verdict: "VERIFIED",
    });
    expectScopeError(resp.status, resp.body);
  });

  it("keeps auth BEFORE scope on federation writes: unauthenticated unscoped POST /v1/federation/verified is 401, leaking no project ids", async () => {
    const resp = await httpPost(`http://localhost:${port}/v1/federation/verified`, {
      entries: [
        {
          taskId: "TASK-777",
          verdict: "VERIFIED",
          commitSha: "abc1234",
          method: "federation-sync",
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      ],
    });
    expect(resp.status).toBe(401);
    const parsed = JSON.parse(resp.body) as ScopeErrorBody;
    expect(parsed.code).not.toBe("PROJECT_SCOPE_REQUIRED");
    expect(parsed.projects).toBeUndefined();
  });

  it("accepts ?project= query scope and writes ONLY the named project's ledger (collision-proof)", async () => {
    const resp = await httpPost(
      `http://localhost:${port}/v1/reviews?project=${encodeURIComponent(idBeta)}`,
      {
        taskId: "TASK-777",
        verdict: "VERIFIED",
        docsImpact: "none",
        commitSha: "beta match 123".replace(/ /g, ""),
        judgment: { stages: { docsReview: { mode: "enforce" } } },
      },
    );
    expect(resp.status).toBe(201);
    const responseBody = JSON.parse(resp.body) as {
      gate: { judgmentOrchestration: { mode: string } };
    };
    expect(responseBody.gate.judgmentOrchestration.mode).toBe("shadow");

    const betaProjection = path.join(rootBeta, ".quack", "verified.json");
    const alphaProjection = path.join(rootAlpha, ".quack", "verified.json");
    expect(fs.existsSync(betaProjection)).toBe(true);
    const betaTasks =
      (
        JSON.parse(fs.readFileSync(betaProjection, "utf-8")) as {
          tasks?: Record<string, { method?: string }>;
        }
      ).tasks ?? {};
    expect(betaTasks["TASK-777"]).toMatchObject({ method: "v1-review" });

    if (fs.existsSync(alphaProjection)) {
      const alphaTasks =
        (
          JSON.parse(fs.readFileSync(alphaProjection, "utf-8")) as {
            tasks?: Record<string, unknown>;
          }
        ).tasks ?? {};
      expect(alphaTasks["TASK-777"]).toBeUndefined();
    }
  });

  it("accepts body projectId scope", async () => {
    const resp = await httpPost(`http://localhost:${port}/v1/reviews`, {
      taskId: "TASK-777",
      verdict: "PARTIAL",
      docsImpact: "none",
      projectId: idAlpha,
    });
    expect(resp.status).toBe(201);
  });

  it("accepts X-Project-Id header scope", async () => {
    const resp = await httpPost(
      `http://localhost:${port}/v1/reviews`,
      { taskId: "TASK-777", verdict: "PARTIAL", docsImpact: "none" },
      { "X-Project-Id": idAlpha },
    );
    expect(resp.status).toBe(201);
  });

  it("terminates an explicit-but-unknown project id deterministically (404 UNKNOWN_PROJECT, never the default project)", async () => {
    const resp = await httpPost(`http://localhost:${port}/v1/reviews?project=no-such-project`, {
      taskId: "TASK-777",
      verdict: "PARTIAL",
      docsImpact: "none",
    });
    expect(resp.status).toBe(404);
    // The project-id middleware terminates unknown ids before any route
    // (PROJECT_NOT_FOUND); the write resolver's own unknown-id branch is
    // unreachable defense-in-depth behind it.
    expect((JSON.parse(resp.body) as ScopeErrorBody).code).toBe("PROJECT_NOT_FOUND");
  });

  it("an unknown project id on /api/tasks/:id/reject writes NOTHING (no legacy fall-through)", async () => {
    const taskFile = path.join(rootAlpha, "docs", "tasks", "TASK-777-fixture.md");
    const before = fs.readFileSync(taskFile, "utf-8");

    const resp = await httpPost(
      `http://localhost:${port}/api/tasks/TASK-777/reject?project=no-such-project`,
      { reason: "should never land" },
    );

    expect(resp.status).toBe(404);
    expect((JSON.parse(resp.body) as ScopeErrorBody).code).toBe("PROJECT_NOT_FOUND");
    expect(fs.readFileSync(taskFile, "utf-8")).toBe(before);
    expect(
      fs.readFileSync(path.join(rootBeta, "docs", "tasks", "TASK-777-fixture.md"), "utf-8"),
    ).not.toContain("REJECTED");
  });

  it("an unknown project id on /api/tasks/:id/verified writes NOTHING to any ledger", async () => {
    const resp = await httpPost(
      `http://localhost:${port}/api/tasks/TASK-777/verified?project=no-such-project`,
      { verdict: "VERIFIED", commit: "deadbeef1", method: "api" },
    );

    expect(resp.status).toBe(404);
    expect((JSON.parse(resp.body) as ScopeErrorBody).code).toBe("PROJECT_NOT_FOUND");
    for (const root of [rootAlpha, rootBeta]) {
      const projection = path.join(root, ".quack", "verified.json");
      if (fs.existsSync(projection)) {
        const tasks =
          (
            JSON.parse(fs.readFileSync(projection, "utf-8")) as {
              tasks?: Record<string, unknown>;
            }
          ).tasks ?? {};
        expect(tasks["TASK-777"]).toBeUndefined();
      }
    }
  });
});

describe("project scope write guard (TASK-1301) — single-project registry", () => {
  let root: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    root = makeTempDir();
    setupProjectDirectory(root, "solo");
    writeTaskFile(root, "TASK-778");
    port = 43000 + Math.floor(Math.random() * 2000);
    const server = createMonitorServer({ port, projectAdapters: makeAdapters([root]) });
    const started = await server.start();
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(root);
  });

  it("unscoped writes still succeed with exactly one registered project", async () => {
    const resp = await httpPost(`http://localhost:${port}/v1/reviews`, {
      taskId: "TASK-778",
      verdict: "PARTIAL",
      docsImpact: "none",
    });
    expect(resp.status).toBe(201);
  });
});

describe("API key effective-project authorization — multi-project fleet routes", () => {
  let tempRoot: string;
  let rootAlpha: string;
  let rootBeta: string;
  let port: number;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    tempRoot = makeTempDir();
    rootAlpha = path.join(tempRoot, "alpha");
    rootBeta = path.join(tempRoot, "beta");
    setupProjectDirectory(rootAlpha, "alpha");
    setupProjectDirectory(rootBeta, "beta");

    const authDir = path.join(tempRoot, "auth-root", ".quack");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({
        users: [{ username: "admin", passwordHash: "not-used", role: "admin" }],
        apiKeys: [
          {
            id: "alpha-key",
            name: "Alpha machine",
            keyHash: await hashPassword("alpha-secret"),
            role: "admin",
            projectScopes: ["alpha"],
          },
          {
            id: "fleet-key",
            name: "Fleet machine",
            keyHash: await hashPassword("fleet-secret"),
            role: "admin",
            projectScopes: ["*"],
          },
        ],
        sessionSecret: "test-secret",
        sessionTtlMs: 60_000,
      }),
      "utf-8",
    );

    port = 43000 + Math.floor(Math.random() * 2000);
    const server = createMonitorServer({
      port,
      quackRoot: path.join(tempRoot, "auth-root"),
      // Registration order deliberately makes beta the mutable active project.
      projectAdapters: makeAdapters([rootBeta, rootAlpha]),
    });
    const started = await server.start();
    stop = started.stop;
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await cleanupDir(tempRoot);
  });

  it.each(["/API/FlEeT/StAtUs", "/API/TaSkS/TASK-999/HeAlTh", "/api/tasks"])(
    "checks an omitted selector against the active project on route %s",
    async (routePath) => {
      const response = await httpGet(`http://localhost:${port}${routePath}`, {
        "x-api-key": "alpha-secret",
      });

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "API_KEY_SCOPE_MISMATCH",
        projectId: "beta",
      });
    },
  );

  it("accepts the scoped key only for its explicitly selected alpha project", async () => {
    const allowed = await httpGet(`http://localhost:${port}/ApI/FlEeT/StAtUs?project=alpha`, {
      "x-api-key": "alpha-secret",
    });
    expect(allowed.status).toBe(200);

    const denied = await httpGet(`http://localhost:${port}/api/fleet/status?project=beta`, {
      "x-api-key": "alpha-secret",
    });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ code: "API_KEY_SCOPE_MISMATCH" });
  });

  it("blocks an explicitly cross-project task mutation before dispatch", async () => {
    const response = await httpPost(
      `http://localhost:${port}/api/tasks/TASK-777/start?project=beta`,
      { localSmokeOnly: true },
      { "x-api-key": "alpha-secret" },
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "API_KEY_SCOPE_MISMATCH",
      projectId: "beta",
    });
  });

  it("preserves active-project fallback for an explicitly wildcard-scoped key", async () => {
    const response = await httpGet(`http://localhost:${port}/api/fleet/status`, {
      "x-api-key": "fleet-secret",
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["/api/tasks/create", { task: { title: "must not land" } }],
    ["/api/testing/run", {}],
    ["/api/intake/apply", {}],
  ])("blocks active-project mutation %s when the key lacks that scope", async (routePath, body) => {
    const response = await httpPost(`http://localhost:${port}${routePath}`, body, {
      "x-api-key": "alpha-secret",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "API_KEY_SCOPE_MISMATCH",
      projectId: "beta",
    });
  });

  it("allows an omitted selector only when the active project is in key scope", async () => {
    const selectAlpha = await httpPost(
      `http://localhost:${port}/api/projects/active`,
      { projectId: "alpha" },
      { "x-api-key": "fleet-secret" },
    );
    expect(selectAlpha.status).toBe(200);

    const response = await httpGet(`http://localhost:${port}/api/tasks`, {
      "x-api-key": "alpha-secret",
    });
    expect(response.status).toBe(200);
  });

  it("requires wildcard scope to create a project registry entry", async () => {
    const response = await httpPost(
      `http://localhost:${port}/api/projects`,
      { path: rootAlpha },
      { "x-api-key": "alpha-secret" },
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "API_KEY_GLOBAL_SCOPE_REQUIRED",
    });
  });

  it("requires wildcard scope for project deletion and leaves the target registered", async () => {
    const response = await httpDelete(`http://localhost:${port}/api/projects/beta`, {
      "x-api-key": "alpha-secret",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "API_KEY_GLOBAL_SCOPE_REQUIRED",
    });
    expect((await httpGet(`http://localhost:${port}/api/projects/beta`)).status).toBe(200);
  });

  it("never exposes fleet survivor reconciliation tokens anonymously", async () => {
    const response = await httpGet(
      `http://localhost:${port}/api/fleet/worktree-shutdown-survivors`,
    );
    expect(response.status).toBe(401);
    expect(response.body).not.toContain("reconciliationToken");
  });
});
