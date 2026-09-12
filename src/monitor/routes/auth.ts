// ─── Auth Routes ───────────────────────────────────────────────────
// Login, logout, and session status endpoints for the monitor dashboard.
// Also exports middleware for protecting routes behind authentication.

import type { Express, Request, Response, NextFunction } from "express";
import type { AuthService, UserRole, ApiKeyPrincipal } from "../auth.js";

const SESSION_COOKIE = "quack_session";

// Express route matching is case-insensitive unless an application opts into
// case-sensitive routing. Security decisions must classify the same path that
// Express will dispatch instead of treating casing as a distinct route.
function securityRoutePath(req: Request): string {
  return req.path.toLowerCase();
}

// ─── Cookie Helpers ───────────────────────────────────────────────

function setSessionCookie(res: Response, sessionId: string, maxAgeMs: number): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function getSessionIdFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return match.split("=")[1] || null;
}

function getApiKeyFromRequest(req: Request): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  if (securityRoutePath(req).startsWith("/v1/")) {
    return null;
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Extract selectors available before route matching. This is only an early
 * rejection layer; the monitor's project registry resolves and authorizes the
 * effective target (including active-project fallback) later.
 */
function getExplicitRequestedProjectId(req: Request): string | null {
  const projectPathMatch = req.path.match(/^\/api\/projects\/(?:active\/)?([^/]+)\/?$/i);
  const encodedPathProject =
    projectPathMatch?.[1]?.toLowerCase() !== "active" ? projectPathMatch?.[1] : undefined;
  let fromPath: string | undefined;
  if (encodedPathProject) {
    try {
      fromPath = decodeURIComponent(encodedPathProject);
    } catch {
      fromPath = encodedPathProject;
    }
  }
  const body = req.body as Record<string, unknown> | undefined;
  const values = [
    fromPath,
    body?.projectId,
    req.query.projectId,
    req.query.project,
    req.headers["x-project-id"],
  ];
  for (const raw of values) {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function getExplicitApiKeyFromRequest(req: Request): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  return null;
}

function isOpenDashboardReadRequest(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  const routePath = securityRoutePath(req);
  return routePath.startsWith("/api/wiki/") || routePath.startsWith("/api/monitoring/");
}

function isReadOnlyRequest(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function isOpenFleetReadRequest(req: Request): boolean {
  const routePath = securityRoutePath(req);
  if (!isReadOnlyRequest(req) || !routePath.startsWith("/api/fleet/")) {
    return false;
  }

  // Survivor records contain opaque reconciliation tokens that authorize
  // release of an admission barrier. Keep the ordinary fleet dashboard reads
  // compatible, but never expose those recovery credentials anonymously when
  // monitor authentication is enabled.
  const protectedRecoveryPaths = new Set([
    "/api/fleet/prep-shutdown-survivors",
    "/api/fleet/shared-checkout-shutdown-survivor",
    "/api/fleet/worktree-shutdown-survivors",
  ]);
  const normalizedPath = routePath.replace(/\/+$/, "");
  return !protectedRecoveryPaths.has(normalizedPath);
}

function isWorkerRefreshServiceTokenRequest(req: Request): boolean {
  const token = req.headers["x-quack-service-token"];
  return (
    req.method === "POST" &&
    typeof token === "string" &&
    token.trim().length > 0 &&
    /^\/api\/workers\/[^/]+\/refresh$/.test(securityRoutePath(req))
  );
}

// ─── Middleware ────────────────────────────────────────────────────

/**
 * Creates middleware that requires authentication.
 * Skips auth for specific paths (health check, login, static assets).
 */
export function createAuthMiddleware(auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const routePath = securityRoutePath(req);
    const apiKey = auth.enabled ? getApiKeyFromRequest(req) : getExplicitApiKeyFromRequest(req);
    if (apiKey) {
      const principal = await auth.authenticateApiKey(apiKey);
      if (!principal) {
        res.status(401).json({
          error: "Invalid API key",
          code: "API_KEY_INVALID",
        });
        return;
      }
      // Complete project authorization is intentionally deferred to the
      // monitor's project-resolution middleware. Global Express middleware
      // runs before route matching, so req.params is empty here. Explicit
      // selectors can fail early, while path/effective-project authorization
      // is repeated against the registry before the operation runs.
      const explicitProjectId = getExplicitRequestedProjectId(req);
      const normalizedRoutePath = routePath.replace(/\/+$/, "");
      const isProjectRegistryOperation =
        normalizedRoutePath === "/api/projects" || normalizedRoutePath.startsWith("/api/projects/");
      if (isProjectRegistryOperation && !principal.projectScopes.includes("*")) {
        res.status(403).json({
          error: "API key requires wildcard scope for this global operation",
          code: "API_KEY_GLOBAL_SCOPE_REQUIRED",
          keyId: principal.id,
        });
        return;
      }
      if (explicitProjectId && !auth.isApiKeyAllowedForProject(principal, explicitProjectId)) {
        res.status(403).json({
          error: "API key is not authorized for this project",
          code: "API_KEY_SCOPE_MISMATCH",
          projectId: explicitProjectId,
          keyId: principal.id,
        });
        return;
      }
      (req as AuthenticatedRequest).apiPrincipal = principal;
      next();
      return;
    }

    // If auth is not enabled (no users configured), pass through before
    // interpreting Bearer tokens as dashboard API keys. This keeps service-token
    // callers and open API routes working in local/test setups that don't use
    // dashboard login.
    if (!auth.enabled) {
      next();
      return;
    }

    // This one dashboard-path mutation is authenticated by the listener route's
    // scoped service-token guard. Let that stricter guard validate the token.
    if (isWorkerRefreshServiceTokenRequest(req)) {
      next();
      return;
    }

    // Allow unauthenticated access to specific paths
    // SSE stream + dispatch jobs are open because internal services (Quack-Quack) consume them
    // Task/settings/projects APIs are open because CLI tools (curl) need them
    const openPaths = [
      "/api/auth/login",
      "/api/auth/status",
      "/api/health",
      "/api/events/stream",
      "/api/dispatch/jobs",
      "/api/projects",
      "/api/projects/active",
      "/api/tasks",
      "/api/sessions",
      "/api/costs",
      "/api/fleet/budget",
      "/api/plan",
      "/api/triage",
      "/api/remotes",
      "/api/agent-resources",
    ];
    const openPrefixes = [
      "/api/tasks/",
      "/api/sessions/",
      "/api/settings",
      "/api/prep/",
      "/api/projects/",
      "/api/diag/",
      "/api/queue/",
      "/api/research/",
      "/api/remotes",
      "/api/dispatch/",
      "/api/admin/runs",
      "/api/agent-resources/",
      "/api/workers/",
    ];
    if (
      routePath === "/api/auth/login" ||
      (isReadOnlyRequest(req) &&
        (isOpenDashboardReadRequest(req) ||
          isOpenFleetReadRequest(req) ||
          openPaths.includes(routePath) ||
          openPrefixes.some((p) => routePath.startsWith(p))))
    ) {
      // Still attach session if available (for viewer guard), but don't require auth
      const sid = getSessionIdFromRequest(req);
      if (sid) {
        const sess = auth.getSession(sid);
        if (sess) {
          (req as AuthenticatedRequest).session = sess;
        }
      }
      next();
      return;
    }

    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      // For API requests, return 401 JSON
      if (routePath.startsWith("/api/")) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      // For non-API requests (dashboard HTML), pass through —
      // the login page is embedded in the SPA and handles client-side
      next();
      return;
    }

    const session = auth.getSession(sessionId);
    if (!session) {
      clearSessionCookie(res);
      if (routePath.startsWith("/api/")) {
        res.status(401).json({ error: "Session expired" });
        return;
      }
      next();
      return;
    }

    // Attach session to request for downstream use
    (req as AuthenticatedRequest).session = session;
    next();
  };
}

/**
 * Middleware that blocks write operations for viewer-role users.
 * Must run AFTER auth middleware.
 */
export function createViewerGuard() {
  const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  // Default-deny every state-changing request for viewers. New routes are
  // therefore protected automatically and must be consciously reviewed before
  // being added to this intentionally narrow allowlist.
  const safeViewerWrites = new Set(["POST /api/auth/logout"]);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!writeMethods.has(req.method)) {
      next();
      return;
    }

    const routePath = securityRoutePath(req);
    const authReq = req as AuthenticatedRequest;
    const role = authReq.session?.role ?? authReq.apiPrincipal?.role;
    // If no authenticated principal (auth disabled or unauthenticated pass-through), allow
    if (!role) {
      next();
      return;
    }

    if (role === "viewer") {
      if (!safeViewerWrites.has(`${req.method} ${routePath}`)) {
        res.status(403).json({
          error: "Insufficient permissions",
          message: "Viewer accounts cannot perform this action",
        });
        return;
      }
    }

    next();
  };
}

// ─── Route Registration ───────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  session?: {
    id: string;
    username: string;
    role: UserRole;
    createdAt: number;
    expiresAt: number;
  };
  apiPrincipal?: ApiKeyPrincipal;
  /** Effective project authorized for this API-key request. */
  effectiveProjectId?: string;
}

export function registerAuthRoutes(app: Express, auth: AuthService): void {
  // Login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body as {
        username?: string;
        password?: string;
      };

      if (!username || !password) {
        res.status(400).json({ error: "Username and password are required" });
        return;
      }

      const session = await auth.login(username, password);
      if (!session) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }

      setSessionCookie(res, session.id, auth.sessionTtlMs);
      res.json({
        username: session.username,
        role: session.role,
        expiresAt: session.expiresAt,
      });
    } catch {
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const sessionId = getSessionIdFromRequest(req);
    if (sessionId) {
      auth.logout(sessionId);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Session status — returns current auth state
  app.get("/api/auth/status", (req: Request, res: Response) => {
    // If auth is not enabled, report that
    if (!auth.enabled) {
      res.json({ authEnabled: false });
      return;
    }

    const sessionId = getSessionIdFromRequest(req);
    if (!sessionId) {
      res.json({ authEnabled: true, authenticated: false });
      return;
    }

    const session = auth.getSession(sessionId);
    if (!session) {
      clearSessionCookie(res);
      res.json({ authEnabled: true, authenticated: false });
      return;
    }

    res.json({
      authEnabled: true,
      authenticated: true,
      username: session.username,
      role: session.role,
      expiresAt: session.expiresAt,
    });
  });
}
