import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import express from "express";

import { AuthService, hashPassword } from "../../src/monitor/auth";
import type { AuthConfig } from "../../src/monitor/auth";
import {
  registerAuthRoutes,
  createAuthMiddleware,
  createViewerGuard,
} from "../../src/monitor/routes/auth";

// ─── Helpers ──────────────────────────────────────────────────────

function makeRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options: http.RequestOptions & { port: number } = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(extraHeaders ?? {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          });
        } catch {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: { raw: data },
          });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractSessionCookie(headers: http.IncomingHttpHeaders): string | null {
  const setCookie = headers["set-cookie"];
  if (!setCookie) return null;
  const match = setCookie[0]?.match(/quack_session=([^;]+)/);
  return match ? `quack_session=${match[1]}` : null;
}

// ─── Test Setup ───────────────────────────────────────────────────

describe("Auth Routes", () => {
  let tmpDir: string;
  let authService: AuthService;
  let app: express.Express;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auth-routes-"));
    fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });

    const config: AuthConfig = {
      users: [],
      apiKeys: [
        {
          id: "test-key",
          name: "Test Machine Key",
          keyHash: await hashPassword("machine-secret"),
          role: "admin",
          projectScopes: ["project-a"],
        },
      ],
      sessionSecret: "test-secret",
      sessionTtlMs: 60 * 1000,
    };
    authService = new AuthService(tmpDir, config);

    app = express();
    app.use(express.json());
    app.use(createAuthMiddleware(authService));
    app.use(createViewerGuard());

    registerAuthRoutes(app, authService);

    // Add a test endpoint that requires auth
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    // Add a test write endpoint
    app.post("/api/tasks/TASK-001/start", (_req, res) => res.json({ dispatched: true }));

    app.get("/api/wiki/status", (_req, res) => res.json({ available: true }));
    app.post("/api/wiki/page", (_req, res) => res.json({ saved: true }));
    app.get("/api/monitoring/environments", (_req, res) => res.json({ environments: [] }));

    // Health endpoint (should always be open)
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
  });

  afterEach(async () => {
    authService.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("when auth is disabled (no users)", () => {
    it("allows all requests without authentication", async () => {
      const res = await makeRequest(server, "GET", "/api/test");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("reports auth disabled in status", async () => {
      const res = await makeRequest(server, "GET", "/api/auth/status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authEnabled: false });
    });

    it("accepts valid API key credentials", async () => {
      const res = await makeRequest(server, "GET", "/api/test", undefined, undefined, {
        "x-api-key": "machine-secret",
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("rejects invalid API key credentials", async () => {
      const res = await makeRequest(server, "GET", "/api/test", undefined, undefined, {
        "x-api-key": "wrong-key",
      });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("API_KEY_INVALID");
    });

    it("rejects API key requests outside key project scope", async () => {
      const res = await makeRequest(
        server,
        "POST",
        "/api/tasks/TASK-001/start?projectId=project-b",
        {},
        undefined,
        { "x-api-key": "machine-secret" },
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("API_KEY_SCOPE_MISMATCH");
    });
  });

  describe("when auth is enabled", () => {
    beforeEach(async () => {
      await authService.addUser("admin", "admin-pass", "admin");
      await authService.addUser("viewer", "viewer-pass", "viewer");
    });

    describe("POST /api/auth/login", () => {
      it("returns session for valid credentials", async () => {
        const res = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        expect(res.status).toBe(200);
        expect(res.body.username).toBe("admin");
        expect(res.body.role).toBe("admin");
        expect(res.body.expiresAt).toBeDefined();
        expect(extractSessionCookie(res.headers)).toBeTruthy();
      });

      it("rejects invalid credentials", async () => {
        const res = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "wrong",
        });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Invalid credentials");
      });

      it("rejects missing fields", async () => {
        const res = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
        });
        expect(res.status).toBe(400);
      });
    });

    describe("authentication middleware", () => {
      it("blocks unauthenticated API requests", async () => {
        const res = await makeRequest(server, "GET", "/api/test");
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Authentication required");
      });

      it("allows authenticated API requests", async () => {
        // Login first
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        const cookie = extractSessionCookie(loginRes.headers);
        expect(cookie).toBeTruthy();

        // Access protected endpoint
        const res = await makeRequest(server, "GET", "/api/test", undefined, cookie!);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      });

      it("always allows /api/health without auth", async () => {
        const res = await makeRequest(server, "GET", "/api/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("ok");
      });

      it("always allows /api/auth/login without auth", async () => {
        const res = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        expect(res.status).toBe(200);
      });

      it("allows unauthenticated wiki read routes", async () => {
        const res = await makeRequest(server, "GET", "/api/wiki/status");
        expect(res.status).toBe(200);
        expect(res.body.available).toBe(true);
      });

      it("allows unauthenticated deployment monitoring read routes", async () => {
        const res = await makeRequest(server, "GET", "/api/monitoring/environments");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.environments)).toBe(true);
      });

      it("blocks unauthenticated wiki write routes", async () => {
        const res = await makeRequest(server, "POST", "/api/wiki/page", {
          path: "wiki/index.md",
        });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Authentication required");
      });

      it("blocks unauthenticated writes even when their route prefix is readable", async () => {
        const res = await makeRequest(server, "POST", "/api/tasks/TASK-001/start", {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Authentication required");
      });

      it("clears cookie and returns 401 for expired session", async () => {
        // Login
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        const cookie = extractSessionCookie(loginRes.headers);

        // Manually invalidate session
        const sessionId = cookie!.split("=")[1];
        authService.logout(sessionId);

        const res = await makeRequest(server, "GET", "/api/test", undefined, cookie!);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("Session expired");
      });
    });

    describe("POST /api/auth/logout", () => {
      it("destroys session and clears cookie", async () => {
        // Login
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        const cookie = extractSessionCookie(loginRes.headers);

        // Logout
        const logoutRes = await makeRequest(server, "POST", "/api/auth/logout", undefined, cookie!);
        expect(logoutRes.status).toBe(200);
        expect(logoutRes.body).toEqual({ ok: true });

        // Session should be invalid
        const res = await makeRequest(server, "GET", "/api/test", undefined, cookie!);
        expect(res.status).toBe(401);
      });
    });

    describe("GET /api/auth/status", () => {
      it("reports unauthenticated when no cookie", async () => {
        const res = await makeRequest(server, "GET", "/api/auth/status");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ authEnabled: true, authenticated: false });
      });

      it("reports authenticated with session details", async () => {
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        const cookie = extractSessionCookie(loginRes.headers);

        const res = await makeRequest(server, "GET", "/api/auth/status", undefined, cookie!);
        expect(res.status).toBe(200);
        expect(res.body.authenticated).toBe(true);
        expect(res.body.username).toBe("admin");
        expect(res.body.role).toBe("admin");
      });
    });

    describe("viewer guard", () => {
      let viewerCookie: string;

      beforeEach(async () => {
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "viewer",
          password: "viewer-pass",
        });
        viewerCookie = extractSessionCookie(loginRes.headers)!;
      });

      it("blocks viewer from dispatch endpoints", async () => {
        const res = await makeRequest(
          server,
          "POST",
          "/api/tasks/TASK-001/start",
          {},
          viewerCookie,
        );
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Insufficient permissions");
      });

      it("allows admin to access dispatch endpoints", async () => {
        const loginRes = await makeRequest(server, "POST", "/api/auth/login", {
          username: "admin",
          password: "admin-pass",
        });
        const adminCookie = extractSessionCookie(loginRes.headers)!;

        const res = await makeRequest(server, "POST", "/api/tasks/TASK-001/start", {}, adminCookie);
        expect(res.status).toBe(200);
        expect(res.body.dispatched).toBe(true);
      });

      it("allows viewer to read (GET) endpoints", async () => {
        const res = await makeRequest(server, "GET", "/api/test", undefined, viewerCookie);
        expect(res.status).toBe(200);
      });

      it("allows viewer to logout (safe POST)", async () => {
        const res = await makeRequest(server, "POST", "/api/auth/logout", undefined, viewerCookie);
        expect(res.status).toBe(200);
      });

      it("blocks viewer from wiki write endpoints", async () => {
        const res = await makeRequest(
          server,
          "POST",
          "/api/wiki/page",
          { path: "wiki/index.md" },
          viewerCookie,
        );
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Insufficient permissions");
      });
    });
  });
});
