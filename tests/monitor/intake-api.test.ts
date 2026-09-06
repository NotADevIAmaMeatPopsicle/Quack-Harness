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
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-intake-test-"));
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
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Create a minimal project structure for scanning.
 * The scanner needs at least a package.json to detect it as a node project.
 */
function createSampleProject(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      scripts: { test: "jest" },
    }),
    "utf-8",
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};", "utf-8");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Intake API Endpoints", () => {
  let logDir: string;
  let projectDir: string;
  let stopServer: (() => Promise<void>) | undefined;
  const port = 30000 + Math.floor(Math.random() * 10000);
  let baseUrl: string;

  beforeAll(async () => {
    logDir = makeTempDir();
    projectDir = makeTempDir();
    createSampleProject(projectDir);
    baseUrl = `http://localhost:${port}`;

    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot: projectDir,
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
  }, 15000);

  afterAll(async () => {
    if (stopServer) await stopServer();
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }, 15000);

  // ─── POST /api/intake/scan ─────────────────────────────────

  describe("POST /api/intake/scan", () => {
    it("returns scan results for a valid project path", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/scan`, {
        projectPath: projectDir,
      });
      expect(status).toBe(200);

      const data = JSON.parse(body) as { ok: boolean; scan: Record<string, unknown> };
      expect(data.ok).toBe(true);
      expect(data.scan).toBeDefined();
      expect(data.scan.projectName).toBe("test-project");
      expect(data.scan.language).toBe("node");
    });

    it("returns 400 when projectPath is missing", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/scan`, {});
      expect(status).toBe(400);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("projectPath");
    });

    it("returns 500 for a nonexistent path", async () => {
      const { status } = await httpPost(`${baseUrl}/api/intake/scan`, {
        projectPath: path.join(os.tmpdir(), "nonexistent-project-xyz-12345"),
      });
      expect(status).toBe(500);
    });
  });

  // ─── POST /api/intake/generate ─────────────────────────────

  describe("POST /api/intake/generate", () => {
    it("returns adapterConfig and conventionsMd for a valid project", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/generate`, {
        projectPath: projectDir,
      });
      expect(status).toBe(200);

      const data = JSON.parse(body) as {
        ok: boolean;
        adapterConfig: Record<string, unknown>;
        conventionsMd: string;
        testingConventionMd: string;
      };
      expect(data.ok).toBe(true);
      expect(data.adapterConfig).toBeDefined();
      expect(data.adapterConfig.project).toBeDefined();
      expect(data.conventionsMd).toBeDefined();
      expect(typeof data.conventionsMd).toBe("string");
      expect(data.testingConventionMd).toBeDefined();
      expect(typeof data.testingConventionMd).toBe("string");
    });

    it("returns 400 when projectPath is missing", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/generate`, {});
      expect(status).toBe(400);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("projectPath");
    });

    it("returns 500 for a nonexistent path", async () => {
      const { status } = await httpPost(`${baseUrl}/api/intake/generate`, {
        projectPath: path.join(os.tmpdir(), "nonexistent-project-xyz-12345"),
      });
      expect(status).toBe(500);
    });
  });

  // ─── POST /api/intake/apply ─────────────────────────────────

  describe("POST /api/intake/apply", () => {
    let applyDir: string;

    beforeEach(() => {
      applyDir = makeTempDir();
      createSampleProject(applyDir);
    });

    afterEach(() => {
      fs.rmSync(applyDir, { recursive: true, force: true });
    });

    it("creates .quack/ directory with expected files", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/apply`, {
        projectPath: applyDir,
      });
      expect(status).toBe(200);

      const data = JSON.parse(body) as { ok: boolean; filesCreated: string[] };
      expect(data.ok).toBe(true);
      expect(data.filesCreated).toContain(".quack/adapter.json");
      expect(data.filesCreated).toContain(".quack/conventions.md");
      expect(data.filesCreated).toContain(".quack/TESTING.md");
      expect(data.filesCreated).toContain(".quack/convention-checks/test-existence-check.js");
      expect(data.filesCreated).toContain(".quack/test-existence.config.json");

      // Verify files exist on disk
      expect(fs.existsSync(path.join(applyDir, ".quack", "adapter.json"))).toBe(true);
      expect(fs.existsSync(path.join(applyDir, ".quack", "conventions.md"))).toBe(true);
      expect(fs.existsSync(path.join(applyDir, ".quack", "TESTING.md"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(applyDir, ".quack", "convention-checks", "test-existence-check.js"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(applyDir, ".quack", "test-existence.config.json"))).toBe(true);
    });

    it("returns 409 if .quack/ already exists", async () => {
      // Create .quack/ directory first
      fs.mkdirSync(path.join(applyDir, ".quack"), { recursive: true });

      const { status, body } = await httpPost(`${baseUrl}/api/intake/apply`, {
        projectPath: applyDir,
      });
      expect(status).toBe(409);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain(".quack/");
    });

    it("returns 400 when projectPath is missing", async () => {
      const { status, body } = await httpPost(`${baseUrl}/api/intake/apply`, {});
      expect(status).toBe(400);

      const data = JSON.parse(body) as { error: string };
      expect(data.error).toContain("projectPath");
    });

    it("returns 500 for a nonexistent path", async () => {
      const { status } = await httpPost(`${baseUrl}/api/intake/apply`, {
        projectPath: path.join(os.tmpdir(), "nonexistent-project-xyz-12345"),
      });
      expect(status).toBe(500);
    });

    it("creates all 5 expected files on disk", async () => {
      await httpPost(`${baseUrl}/api/intake/apply`, {
        projectPath: applyDir,
      });

      const quackDir = path.join(applyDir, ".quack");
      const expectedFiles = [
        "adapter.json",
        "conventions.md",
        "TESTING.md",
        "convention-checks/test-existence-check.js",
        "test-existence.config.json",
      ];

      for (const f of expectedFiles) {
        const filePath = path.join(quackDir, f);
        expect(fs.existsSync(filePath)).toBe(true);

        // Verify files have content
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      }
    });

    it("generated adapter.json is valid JSON", async () => {
      await httpPost(`${baseUrl}/api/intake/apply`, {
        projectPath: applyDir,
      });

      const adapterPath = path.join(applyDir, ".quack", "adapter.json");
      const content = fs.readFileSync(adapterPath, "utf-8");
      const config = JSON.parse(content) as Record<string, unknown>;
      expect(config.project).toBeDefined();
      expect(config.agent).toBeDefined();
      expect(config.sandbox).toBeDefined();
    });
  });

  // ─── Tab navigation ─────────────────────────────────────────

  describe("Intake tab in dashboard", () => {
    it("dashboard HTML includes Intake tab button", async () => {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get(`${baseUrl}/`, (res) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            res.on("error", reject);
          })
          .on("error", reject);
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain("switchTab('intake')");
      expect(res.body).toContain("tab-intake");
      expect(res.body).toContain("Intake");
    });
  });
});
