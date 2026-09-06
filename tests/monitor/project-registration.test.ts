import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-project-registration-"));
}

async function getFreePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
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

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function httpDelete(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "DELETE",
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end();
  });
}

function makeMinimalAdapterConfig(
  projectName: string,
  projectRoot: string,
): Record<string, unknown> {
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
    verification: {
      commands: [
        { name: "test", command: "echo test", scope: "all", required: true, timeout: 30000 },
      ],
      conventionChecks: [],
    },
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
  };
}

function setupProjectDirectory(projectRoot: string, projectName: string): void {
  const quackDir = path.join(projectRoot, ".quack");
  fs.mkdirSync(quackDir, { recursive: true });
  fs.mkdirSync(path.join(quackDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });

  const config = makeMinimalAdapterConfig(projectName, projectRoot);
  fs.writeFileSync(path.join(quackDir, "adapter.json"), JSON.stringify(config, null, 2), "utf-8");

  // Create sessions.jsonl for event reader
  fs.writeFileSync(path.join(quackDir, "logs", "sessions.jsonl"), "", "utf-8");
}

function makeAdapters(
  projectRoots: string[],
): import("../../src/core/adapter-loader").ProjectAdapter[] {
  return projectRoots.map((root) => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(root, ".quack", "adapter.json"), "utf-8"),
    ) as import("../../src/core/types").AdapterConfig;
    return {
      projectRoot: root,
      config: raw,
      conventionsDoc: "",
      judgeCriteria: "",
      conventionCheckScripts: [],
      adrDocs: {},
      adapterBundle: {
        authority: "local",
        sharedHash: "test-shared-hash",
        normalizedConfig: raw,
        machineLocalFields: [],
      },
    };
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe("POST /api/projects - Dynamic project registration", () => {
  let stopServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
  });

  it("POST /api/projects registers a new project at runtime", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      setupProjectDirectory(projectRoot2, "Project Beta");

      // Start server with only Project Alpha
      const adapters = makeAdapters([projectRoot1]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Initially only 1 project
      const beforeRes = await httpGet(`http://localhost:${port}/api/projects`);
      expect(beforeRes.status).toBe(200);
      const beforeData = JSON.parse(beforeRes.body) as Array<{ id: string; name: string }>;
      expect(beforeData).toHaveLength(1);
      expect(beforeData[0].name).toBe("Project Alpha");

      // Add Project Beta
      const addRes = await httpPost(`http://localhost:${port}/api/projects`, {
        path: projectRoot2,
      });
      expect(addRes.status).toBe(200);
      const addData = JSON.parse(addRes.body) as { ok: boolean; projectId: string; name: string };
      expect(addData.ok).toBe(true);
      expect(addData.projectId).toBe("project-beta");
      expect(addData.name).toBe("Project Beta");

      // Now 2 projects
      const afterRes = await httpGet(`http://localhost:${port}/api/projects`);
      expect(afterRes.status).toBe(200);
      const afterData = JSON.parse(afterRes.body) as Array<{ id: string; name: string }>;
      expect(afterData).toHaveLength(2);
      expect(afterData.map((d) => d.name).sort()).toEqual(["Project Alpha", "Project Beta"]);
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });

  it("POST /api/projects returns 400 for non-existent path", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");

      const adapters = makeAdapters([projectRoot1]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const addRes = await httpPost(`http://localhost:${port}/api/projects`, {
        path: "/non/existent/path",
      });
      expect(addRes.status).toBe(400);
      const data = JSON.parse(addRes.body) as { error: string };
      expect(data.error).toContain("does not exist");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
    }
  });

  it("POST /api/projects returns 400 for path missing adapter.json", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      // Create projectRoot2 but without adapter.json
      fs.mkdirSync(projectRoot2, { recursive: true });

      const adapters = makeAdapters([projectRoot1]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const addRes = await httpPost(`http://localhost:${port}/api/projects`, {
        path: projectRoot2,
      });
      expect(addRes.status).toBe(400);
      const data = JSON.parse(addRes.body) as { error: string };
      expect(data.error).toContain("adapter.json");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });

  it("POST /api/projects returns 409 for already-registered project", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");

      const adapters = makeAdapters([projectRoot1]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Try to add the same project again
      const addRes = await httpPost(`http://localhost:${port}/api/projects`, {
        path: projectRoot1,
      });
      expect(addRes.status).toBe(409);
      const data = JSON.parse(addRes.body) as { error: string };
      expect(data.error).toContain("already registered");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
    }
  });
});

describe("DELETE /api/projects/:id - Dynamic project unregistration", () => {
  let stopServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
  });

  it("DELETE /api/projects/:id unregisters a project", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      setupProjectDirectory(projectRoot2, "Project Beta");

      const adapters = makeAdapters([projectRoot1, projectRoot2]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Initially 2 projects
      const beforeRes = await httpGet(`http://localhost:${port}/api/projects`);
      expect(beforeRes.status).toBe(200);
      const beforeData = JSON.parse(beforeRes.body) as Array<{ id: string; name: string }>;
      expect(beforeData).toHaveLength(2);

      // Unregister Project Beta
      const deleteRes = await httpDelete(`http://localhost:${port}/api/projects/project-beta`);
      expect(deleteRes.status).toBe(200);
      const deleteData = JSON.parse(deleteRes.body) as { ok: boolean; message: string };
      expect(deleteData.ok).toBe(true);

      // Now only 1 project
      const afterRes = await httpGet(`http://localhost:${port}/api/projects`);
      expect(afterRes.status).toBe(200);
      const afterData = JSON.parse(afterRes.body) as Array<{ id: string; name: string }>;
      expect(afterData).toHaveLength(1);
      expect(afterData[0].name).toBe("Project Alpha");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });

  it("DELETE /api/projects/:id returns 404 for non-existent project", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");

      const adapters = makeAdapters([projectRoot1]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      const deleteRes = await httpDelete(`http://localhost:${port}/api/projects/non-existent`);
      expect(deleteRes.status).toBe(404);
      const data = JSON.parse(deleteRes.body) as { error: string };
      expect(data.error).toContain("not found");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
    }
  });

  it("DELETE /api/projects/:id returns 409 when project has active dispatches", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      setupProjectDirectory(projectRoot2, "Project Beta");

      const adapters = makeAdapters([projectRoot1, projectRoot2]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Simulate an active dispatch on Project Beta by overriding getActiveJobs
      const betaContext = serverObj.registry!.getProject("project-beta")!;
      expect(betaContext.dispatchManager).not.toBeNull();
      betaContext.dispatchManager!.getActiveJobs = () => [
        { taskId: "TASK-001", status: "running" } as never,
      ];

      // Try to delete — should get 409
      const deleteRes = await httpDelete(`http://localhost:${port}/api/projects/project-beta`);
      expect(deleteRes.status).toBe(409);
      const data = JSON.parse(deleteRes.body) as { error: string };
      expect(data.error).toContain("active dispatches");

      // Project should still be in the registry
      const afterRes = await httpGet(`http://localhost:${port}/api/projects`);
      const afterData = JSON.parse(afterRes.body) as Array<{ id: string }>;
      expect(afterData).toHaveLength(2);
      expect(afterData.find((p) => p.id === "project-beta")).toBeDefined();
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });

  it("DELETE /api/projects/:id calls teardown on DELETE (stops watcher, detector, queue)", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      setupProjectDirectory(projectRoot2, "Project Beta");

      const adapters = makeAdapters([projectRoot1, projectRoot2]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Spy on the services of Project Beta to verify teardown is called
      const betaContext = serverObj.registry!.getProject("project-beta")!;

      const stopWatcherSpy = jest.fn();
      betaContext.stopWatcher = stopWatcherSpy;

      const stopCheckingSpy = jest.fn();
      betaContext.progressDetector.stopChecking = stopCheckingSpy;

      // Delete Project Beta
      const deleteRes = await httpDelete(`http://localhost:${port}/api/projects/project-beta`);
      expect(deleteRes.status).toBe(200);

      // Verify teardown was called
      expect(stopWatcherSpy).toHaveBeenCalledTimes(1);
      expect(stopCheckingSpy).toHaveBeenCalledTimes(1);

      // Project should be removed
      const afterRes = await httpGet(`http://localhost:${port}/api/projects`);
      const afterData = JSON.parse(afterRes.body) as Array<{ id: string }>;
      expect(afterData).toHaveLength(1);
      expect(afterData[0].id).toBe("project-alpha");
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });

  it("DELETE /api/projects/:id switches active project when removing the active one", async () => {
    const port = await getFreePort();
    const projectRoot1 = makeTempDir();
    const projectRoot2 = makeTempDir();

    try {
      setupProjectDirectory(projectRoot1, "Project Alpha");
      setupProjectDirectory(projectRoot2, "Project Beta");

      const adapters = makeAdapters([projectRoot1, projectRoot2]);
      const serverObj = createMonitorServer({ port, projectAdapters: adapters });
      const { stop } = await serverObj.start();
      stopServer = stop;

      // Project Alpha is active by default
      const beforeRes = await httpGet(`http://localhost:${port}/api/projects`);
      const beforeData = JSON.parse(beforeRes.body) as Array<{ id: string; active: boolean }>;
      expect(beforeData.find((p) => p.id === "project-alpha")?.active).toBe(true);

      // Remove Project Alpha
      const deleteRes = await httpDelete(`http://localhost:${port}/api/projects/project-alpha`);
      expect(deleteRes.status).toBe(200);

      // Project Beta should now be active
      const afterRes = await httpGet(`http://localhost:${port}/api/projects`);
      const afterData = JSON.parse(afterRes.body) as Array<{ id: string; active: boolean }>;
      expect(afterData).toHaveLength(1);
      expect(afterData[0].id).toBe("project-beta");
      expect(afterData[0].active).toBe(true);
    } finally {
      // Stop before rmSync: Windows cannot unlink the project quack.db while open.
      if (stopServer) {
        await stopServer();
        stopServer = null;
      }
      fs.rmSync(projectRoot1, { recursive: true, force: true });
      fs.rmSync(projectRoot2, { recursive: true, force: true });
    }
  });
});
