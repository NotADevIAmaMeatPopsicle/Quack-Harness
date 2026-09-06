import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  hashPassword,
  hashServiceToken,
  verifyPassword,
  loadAuthConfig,
  saveAuthConfig,
  initAuthConfig,
  AuthService,
} from "../../src/monitor/auth";
import type { AuthConfig } from "../../src/monitor/auth";

describe("Auth - Password Hashing", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).toContain(":");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("produces different hashes for same password (unique salts)", async () => {
    const hash1 = await hashPassword("same-password");
    const hash2 = await hashPassword("same-password");
    expect(hash1).not.toBe(hash2);
    // Both should still verify
    expect(await verifyPassword("same-password", hash1)).toBe(true);
    expect(await verifyPassword("same-password", hash2)).toBe(true);
  });

  it("returns false for malformed hash", async () => {
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("Auth - Config Persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auth-"));
    // Create .quack subdirectory
    fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config exists", () => {
    expect(loadAuthConfig(tmpDir)).toBeNull();
  });

  it("saves and loads config", () => {
    const config: AuthConfig = {
      users: [{ username: "admin", passwordHash: "salt:hash", role: "admin" }],
      apiKeys: [],
      serviceTokens: [],
      sessionSecret: "test-secret",
      sessionTtlMs: 3600000,
    };
    saveAuthConfig(tmpDir, config);
    const loaded = loadAuthConfig(tmpDir);
    expect(loaded).toEqual(config);
  });

  it("initializes config if none exists", () => {
    const config = initAuthConfig(tmpDir);
    expect(config.users).toEqual([]);
    expect(config.sessionSecret).toBeTruthy();
    expect(config.sessionTtlMs).toBe(24 * 60 * 60 * 1000);

    // File should exist now
    const filePath = path.join(tmpDir, ".quack", "auth.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("returns existing config if already initialized", () => {
    const config1 = initAuthConfig(tmpDir);
    const config2 = initAuthConfig(tmpDir);
    expect(config1.sessionSecret).toBe(config2.sessionSecret);
  });

  it("handles corrupted config file gracefully", () => {
    const filePath = path.join(tmpDir, ".quack", "auth.json");
    fs.writeFileSync(filePath, "not-json", "utf-8");
    expect(loadAuthConfig(tmpDir)).toBeNull();
  });

  it("creates .quack directory if missing", () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auth-bare-"));
    try {
      const config: AuthConfig = {
        users: [],
        sessionSecret: "s",
        sessionTtlMs: 1000,
      };
      saveAuthConfig(bareDir, config);
      expect(fs.existsSync(path.join(bareDir, ".quack", "auth.json"))).toBe(true);
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe("AuthService", () => {
  let tmpDir: string;
  let service: AuthService;
  let config: AuthConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-auth-svc-"));
    fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });

    config = {
      users: [],
      sessionSecret: "test-secret",
      sessionTtlMs: 60 * 1000, // 1 minute for tests
    };
    service = new AuthService(tmpDir, config);
  });

  afterEach(() => {
    service.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("enabled", () => {
    it("returns false when no users configured", () => {
      expect(service.enabled).toBe(false);
    });

    it("returns true after adding a user", async () => {
      await service.addUser("alice", "password123");
      expect(service.enabled).toBe(true);
    });
  });

  describe("API key authentication", () => {
    beforeEach(async () => {
      config.apiKeys = [
        {
          id: "ops-key",
          name: "Operations",
          keyHash: await hashPassword("quack-secret"),
          role: "admin",
          projectScopes: ["project-alpha"],
        },
      ];
      service.destroy();
      service = new AuthService(tmpDir, config);
    });

    it("authenticates a valid API key", async () => {
      const principal = await service.authenticateApiKey("quack-secret");
      expect(principal).not.toBeNull();
      expect(principal?.id).toBe("ops-key");
      expect(principal?.role).toBe("admin");
    });

    it("rejects invalid API keys", async () => {
      const principal = await service.authenticateApiKey("wrong-key");
      expect(principal).toBeNull();
    });

    it("enforces project scope checks", async () => {
      const principal = await service.authenticateApiKey("quack-secret");
      expect(principal).not.toBeNull();
      expect(service.isApiKeyAllowedForProject(principal!, "project-alpha")).toBe(true);
      expect(service.isApiKeyAllowedForProject(principal!, "project-beta")).toBe(false);
    });
  });

  describe("service token scopes", () => {
    beforeEach(() => {
      config.serviceTokens = [
        {
          id: "listener-admin",
          tokenHash: hashServiceToken("admin-token"),
          scopes: ["listener:admin"],
        },
        {
          id: "listener-heartbeat",
          tokenHash: hashServiceToken("heartbeat-token"),
          scopes: ["listener:heartbeat"],
        },
      ];
      service.destroy();
      service = new AuthService(tmpDir, config);
    });

    it("treats listener:admin as a superset for listener bootstrap scopes", () => {
      expect(service.validateServiceToken("admin-token", "listener:register")).toMatchObject({
        ok: true,
        tokenId: "listener-admin",
      });
      expect(service.validateServiceToken("admin-token", "listener:read")).toMatchObject({
        ok: true,
        tokenId: "listener-admin",
      });
      expect(service.validateServiceToken("admin-token", "listener:heartbeat")).toMatchObject({
        ok: true,
        tokenId: "listener-admin",
      });
    });

    it("does not let a granular listener token act as listener admin", () => {
      expect(service.validateServiceToken("heartbeat-token", "listener:admin")).toMatchObject({
        ok: false,
        status: 403,
        error: "service_token_scope_denied",
      });
    });
  });

  describe("login", () => {
    beforeEach(async () => {
      await service.addUser("alice", "password123", "admin");
      await service.addUser("bob", "viewer-pass", "viewer");
    });

    it("returns session for valid credentials", async () => {
      const session = await service.login("alice", "password123");
      expect(session).not.toBeNull();
      expect(session!.username).toBe("alice");
      expect(session!.role).toBe("admin");
      expect(session!.id).toBeTruthy();
      expect(session!.expiresAt).toBeGreaterThan(Date.now());
    });

    it("returns null for wrong password", async () => {
      const session = await service.login("alice", "wrong");
      expect(session).toBeNull();
    });

    it("returns null for nonexistent user", async () => {
      const session = await service.login("charlie", "password123");
      expect(session).toBeNull();
    });

    it("is case-insensitive for username", async () => {
      const session = await service.login("ALICE", "password123");
      expect(session).not.toBeNull();
      expect(session!.username).toBe("alice");
    });
  });

  describe("session management", () => {
    it("validates active session", async () => {
      await service.addUser("alice", "pass");
      const session = await service.login("alice", "pass");
      expect(session).not.toBeNull();

      const retrieved = service.getSession(session!.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.username).toBe("alice");
    });

    it("returns null for unknown session ID", () => {
      expect(service.getSession("nonexistent")).toBeNull();
    });

    it("invalidates expired session", async () => {
      // Create service with 1ms TTL
      const shortConfig: AuthConfig = {
        users: [],
        sessionSecret: "s",
        sessionTtlMs: 1,
      };
      const shortService = new AuthService(tmpDir, shortConfig);
      try {
        await shortService.addUser("alice", "pass");
        const session = await shortService.login("alice", "pass");
        expect(session).not.toBeNull();

        // Wait for expiry
        await new Promise((r) => setTimeout(r, 10));
        expect(shortService.getSession(session!.id)).toBeNull();
      } finally {
        shortService.destroy();
      }
    });

    it("logout destroys session", async () => {
      await service.addUser("alice", "pass");
      const session = await service.login("alice", "pass");
      expect(session).not.toBeNull();

      const result = service.logout(session!.id);
      expect(result).toBe(true);
      expect(service.getSession(session!.id)).toBeNull();
    });

    it("logout returns false for unknown session", () => {
      expect(service.logout("nonexistent")).toBe(false);
    });
  });

  describe("session cleanup", () => {
    it("cleans expired sessions", async () => {
      const shortConfig: AuthConfig = {
        users: [],
        sessionSecret: "s",
        sessionTtlMs: 1,
      };
      const shortService = new AuthService(tmpDir, shortConfig);
      try {
        await shortService.addUser("alice", "pass");
        await shortService.login("alice", "pass");
        await shortService.login("alice", "pass");

        await new Promise((r) => setTimeout(r, 10));
        const cleaned = shortService.cleanExpiredSessions();
        expect(cleaned).toBe(2);
        expect(shortService.getActiveSessionCount()).toBe(0);
      } finally {
        shortService.destroy();
      }
    });
  });

  describe("user management", () => {
    it("adds user and persists to disk", async () => {
      await service.addUser("alice", "pass", "admin");

      const users = service.listUsers();
      expect(users).toEqual([{ username: "alice", role: "admin" }]);

      // Verify persisted
      const saved = loadAuthConfig(tmpDir);
      expect(saved!.users).toHaveLength(1);
      expect(saved!.users[0].username).toBe("alice");
    });

    it("rejects duplicate username", async () => {
      await service.addUser("alice", "pass");
      await expect(service.addUser("alice", "other")).rejects.toThrow(
        'User "alice" already exists',
      );
    });

    it("rejects duplicate username case-insensitively", async () => {
      await service.addUser("alice", "pass");
      await expect(service.addUser("ALICE", "other")).rejects.toThrow();
    });

    it("defaults to viewer role", async () => {
      await service.addUser("bob", "pass");
      expect(service.listUsers()).toEqual([{ username: "bob", role: "viewer" }]);
    });

    it("removes user and invalidates sessions", async () => {
      await service.addUser("alice", "pass");
      const session = await service.login("alice", "pass");

      const removed = service.removeUser("alice");
      expect(removed).toBe(true);
      expect(service.listUsers()).toEqual([]);
      expect(service.getSession(session!.id)).toBeNull();
    });

    it("removeUser returns false for nonexistent user", () => {
      expect(service.removeUser("ghost")).toBe(false);
    });

    it("changes password", async () => {
      await service.addUser("alice", "old-pass");
      const changed = await service.changePassword("alice", "new-pass");
      expect(changed).toBe(true);

      // Old password should fail
      expect(await service.login("alice", "old-pass")).toBeNull();
      // New password should work
      expect(await service.login("alice", "new-pass")).not.toBeNull();
    });

    it("changePassword returns false for nonexistent user", async () => {
      expect(await service.changePassword("ghost", "pass")).toBe(false);
    });

    it("changes role", async () => {
      await service.addUser("alice", "pass", "viewer");
      const changed = service.changeRole("alice", "admin");
      expect(changed).toBe(true);

      expect(service.listUsers()).toEqual([{ username: "alice", role: "admin" }]);
    });

    it("changeRole returns false for nonexistent user", () => {
      expect(service.changeRole("ghost", "admin")).toBe(false);
    });
  });
});
