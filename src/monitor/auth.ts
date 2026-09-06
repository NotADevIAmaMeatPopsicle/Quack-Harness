// ─── Auth Service ──────────────────────────────────────────────────
// Lightweight authentication for the Quack Monitor dashboard.
// Uses Node.js built-in crypto (scrypt) for password hashing and
// an in-memory session store. Credentials stored in .quack/auth.json.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────

export type UserRole = "admin" | "viewer";

export interface StoredUser {
  username: string;
  passwordHash: string; // scrypt hash as "salt:hash" hex
  role: UserRole;
}

export interface StoredServiceToken {
  id: string;
  tokenHash: string; // sha256 hex
  scopes: string[];
  enabled?: boolean;
}

export interface StoredApiKey {
  id: string;
  name: string;
  keyHash: string; // scrypt hash as "salt:hash" hex
  role: UserRole;
  /** Allowed project IDs; use "*" for all projects. */
  projectScopes: string[];
  enabled?: boolean;
}

export interface ApiKeyPrincipal {
  type: "api_key";
  id: string;
  name: string;
  role: UserRole;
  projectScopes: string[];
}

export interface AuthConfig {
  users: StoredUser[];
  serviceTokens?: StoredServiceToken[];
  apiKeys?: StoredApiKey[];
  sessionSecret: string;
  sessionTtlMs: number; // default 24h
}

export interface Session {
  id: string;
  username: string;
  role: UserRole;
  createdAt: number;
  expiresAt: number;
}

// ─── Constants ─────────────────────────────────────────────────────

const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Password Hashing ─────────────────────────────────────────────

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
    crypto.scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, hash] = storedHash.split(":");
    if (!salt || !hash) {
      resolve(false);
      return;
    }
    crypto.scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString("hex") === hash);
    });
  });
}

export function hashServiceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function serviceTokenHasScope(scopes: string[], requiredScope: string): boolean {
  if (scopes.includes("*") || scopes.includes(requiredScope)) return true;
  const [namespace, action] = requiredScope.split(":", 2);
  if (!namespace || !action || action === "admin") return false;
  return scopes.includes(`${namespace}:admin`);
}

// ─── Auth Config Persistence ──────────────────────────────────────

function getAuthConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".quack", "auth.json");
}

export function loadAuthConfig(projectRoot: string): AuthConfig | null {
  const configPath = getAuthConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    return {
      users: Array.isArray(raw.users) ? (raw.users as StoredUser[]) : [],
      serviceTokens: Array.isArray(raw.serviceTokens)
        ? (raw.serviceTokens as StoredServiceToken[])
        : [],
      apiKeys: Array.isArray(raw.apiKeys) ? (raw.apiKeys as StoredApiKey[]) : [],
      sessionSecret:
        typeof raw.sessionSecret === "string"
          ? raw.sessionSecret
          : crypto.randomBytes(32).toString("hex"),
      sessionTtlMs:
        typeof raw.sessionTtlMs === "number" ? raw.sessionTtlMs : DEFAULT_SESSION_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function saveAuthConfig(projectRoot: string, config: AuthConfig): void {
  const configPath = getAuthConfigPath(projectRoot);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function initAuthConfig(projectRoot: string): AuthConfig {
  const existing = loadAuthConfig(projectRoot);
  if (existing) return existing;

  const config: AuthConfig = {
    users: [],
    serviceTokens: [],
    apiKeys: [],
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  };
  saveAuthConfig(projectRoot, config);
  return config;
}

// ─── Auth Service Class ───────────────────────────────────────────

export class AuthService {
  private config: AuthConfig;
  private sessions = new Map<string, Session>();
  private projectRoot: string;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(projectRoot: string, config: AuthConfig) {
    this.projectRoot = projectRoot;
    this.config = config;

    // Periodically clean expired sessions (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanExpiredSessions(), 5 * 60 * 1000);
    this.cleanupInterval.unref(); // Don't block Jest or process exit
  }

  /** Whether auth is enabled (at least one user configured) */
  get enabled(): boolean {
    return this.config.users.length > 0;
  }

  get sessionTtlMs(): number {
    return this.config.sessionTtlMs;
  }

  get apiKeyCount(): number {
    return this.config.apiKeys?.filter((key) => key.enabled !== false).length ?? 0;
  }

  /** Authenticate a user, returns a session if valid */
  async login(username: string, password: string): Promise<Session | null> {
    const user = this.config.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return null;

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return null;

    const session = this.createSession(user.username, user.role);
    return session;
  }

  /** Create a new session */
  private createSession(username: string, role: UserRole): Session {
    const id = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const session: Session = {
      id,
      username,
      role,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Validate a session token, returns session if valid */
  getSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  /** Destroy a session (logout) */
  logout(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Remove all expired sessions */
  cleanExpiredSessions(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Get count of active sessions */
  getActiveSessionCount(): number {
    this.cleanExpiredSessions();
    return this.sessions.size;
  }

  validateServiceToken(
    token: string | undefined,
    requiredScope: string,
  ):
    | { ok: true; tokenId: string }
    | { ok: false; status: 401 | 403; error: string; message: string } {
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: "service_token_required",
        message: "Federated write endpoints require a scoped service token.",
      };
    }

    const tokenHash = hashServiceToken(token);
    const serviceToken = (this.config.serviceTokens ?? []).find(
      (candidate) => candidate.enabled !== false && candidate.tokenHash === tokenHash,
    );
    if (!serviceToken) {
      return {
        ok: false,
        status: 401,
        error: "service_token_invalid",
        message: "Service token is missing, disabled, or invalid.",
      };
    }

    if (!serviceTokenHasScope(serviceToken.scopes, requiredScope)) {
      return {
        ok: false,
        status: 403,
        error: "service_token_scope_denied",
        message: `Service token ${serviceToken.id} lacks required scope ${requiredScope}.`,
      };
    }

    return { ok: true, tokenId: serviceToken.id };
  }

  async authenticateApiKey(rawKey: string): Promise<ApiKeyPrincipal | null> {
    const key = rawKey.trim();
    if (!key) return null;

    for (const candidate of this.config.apiKeys ?? []) {
      if (candidate.enabled === false) continue;
      const valid = await verifyPassword(key, candidate.keyHash);
      if (!valid) continue;
      return {
        type: "api_key",
        id: candidate.id,
        name: candidate.name,
        role: candidate.role,
        projectScopes: candidate.projectScopes ?? [],
      };
    }
    return null;
  }

  isApiKeyAllowedForProject(
    principal: ApiKeyPrincipal,
    projectId: string | null | undefined,
  ): boolean {
    if (!projectId) return true;
    return principal.projectScopes.includes("*") || principal.projectScopes.includes(projectId);
  }

  createServiceToken(
    id: string,
    scopes: string[],
  ): { id: string; token: string; scopes: string[] } {
    const existing = (this.config.serviceTokens ?? []).find(
      (token) => token.id.toLowerCase() === id.toLowerCase(),
    );
    if (existing) {
      throw new Error(`Service token "${id}" already exists`);
    }

    const token = `qsvc_${crypto.randomBytes(24).toString("hex")}`;
    const serviceToken: StoredServiceToken = {
      id,
      tokenHash: hashServiceToken(token),
      scopes: [...new Set(scopes)].sort((a, b) => a.localeCompare(b)),
      enabled: true,
    };
    this.config.serviceTokens = this.config.serviceTokens ?? [];
    this.config.serviceTokens.push(serviceToken);
    saveAuthConfig(this.projectRoot, this.config);
    return { id, token, scopes: serviceToken.scopes };
  }

  // ─── User Management ─────────────────────────────────────────────

  async addUser(username: string, password: string, role: UserRole = "viewer"): Promise<void> {
    const existing = this.config.users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      throw new Error(`User "${username}" already exists`);
    }
    const passwordHash = await hashPassword(password);
    this.config.users.push({ username, passwordHash, role });
    saveAuthConfig(this.projectRoot, this.config);
  }

  removeUser(username: string): boolean {
    const idx = this.config.users.findIndex(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );
    if (idx === -1) return false;

    this.config.users.splice(idx, 1);
    saveAuthConfig(this.projectRoot, this.config);

    // Invalidate any sessions for this user
    for (const [id, session] of this.sessions) {
      if (session.username.toLowerCase() === username.toLowerCase()) {
        this.sessions.delete(id);
      }
    }
    return true;
  }

  async changePassword(username: string, newPassword: string): Promise<boolean> {
    const user = this.config.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return false;

    user.passwordHash = await hashPassword(newPassword);
    saveAuthConfig(this.projectRoot, this.config);
    return true;
  }

  changeRole(username: string, newRole: UserRole): boolean {
    const user = this.config.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return false;

    user.role = newRole;
    saveAuthConfig(this.projectRoot, this.config);
    return true;
  }

  listUsers(): Array<{ username: string; role: UserRole }> {
    return this.config.users.map((u) => ({
      username: u.username,
      role: u.role,
    }));
  }

  /** Stop the cleanup interval */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}
