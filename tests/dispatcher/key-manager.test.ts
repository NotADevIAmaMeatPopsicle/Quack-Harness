import { KeyManager, isRateLimitError, parseRetryAfter } from "../../src/dispatcher/key-manager.js";

describe("KeyManager", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("single key setup (backward compatibility)", () => {
    test("works with only ANTHROPIC_API_KEY", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";

      const manager = new KeyManager({ strategy: "round-robin" });

      const key = manager.getNextKey();
      expect(key).not.toBeNull();
      expect(key?.id).toBe("key-1");
      expect(key?.isAvailable).toBe(true);
    });

    test("returns null when no keys are configured", () => {
      delete process.env.ANTHROPIC_API_KEY;

      const manager = new KeyManager({ strategy: "round-robin" });

      const key = manager.getNextKey();
      expect(key).toBeNull();
    });
  });

  describe("round-robin strategy", () => {
    test("rotates through 3 keys in order", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";
      process.env.ANTHROPIC_API_KEY_3 = "sk-ant-key3";

      const manager = new KeyManager({ strategy: "round-robin" });

      const k1 = manager.getNextKey();
      expect(k1?.id).toBe("key-1");

      const k2 = manager.getNextKey();
      expect(k2?.id).toBe("key-2");

      const k3 = manager.getNextKey();
      expect(k3?.id).toBe("key-3");

      // Should wrap back to key-1
      const k4 = manager.getNextKey();
      expect(k4?.id).toBe("key-1");
    });

    test("skips gaps in key sequence", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      // No _2
      process.env.ANTHROPIC_API_KEY_3 = "sk-ant-key3"; // Should be ignored (gap)

      const manager = new KeyManager({ strategy: "round-robin" });

      const k1 = manager.getNextKey();
      expect(k1?.id).toBe("key-1");

      // Only key-1 should be available
      const k2 = manager.getNextKey();
      expect(k2?.id).toBe("key-1");
    });
  });

  describe("rate limit handling", () => {
    test("excludes rate-limited key from rotation", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.markRateLimited("key-1", 5000);

      const k1 = manager.getNextKey();
      expect(k1?.id).toBe("key-2");

      const k2 = manager.getNextKey();
      expect(k2?.id).toBe("key-2"); // Still key-2, key-1 is rate-limited
    });

    test("returns null when all keys are rate-limited", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.markRateLimited("key-1", 5000);
      manager.markRateLimited("key-2", 5000);

      const key = manager.getNextKey();
      expect(key).toBeNull();
    });

    test("re-enables key after cooldown expires", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";

      const manager = new KeyManager({ strategy: "round-robin", cooldownMs: 100 });

      manager.markRateLimited("key-1", 100);

      // Key should be unavailable initially
      expect(manager.getNextKey()).toBeNull();

      // Wait for cooldown to expire
      return new Promise((resolve) => {
        setTimeout(() => {
          const key = manager.getNextKey();
          expect(key?.id).toBe("key-1");
          expect(key?.isAvailable).toBe(true);
          resolve(undefined);
        }, 150);
      });
    });
  });

  describe("per-key cost tracking", () => {
    test("accumulates cost per key", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.recordCost("key-1", 1.5);
      manager.recordCost("key-1", 0.5);
      manager.recordCost("key-2", 2.0);

      const health = manager.getKeyHealth();
      const key1 = health.find((k) => k.id === "key-1");
      const key2 = health.find((k) => k.id === "key-2");

      expect(key1?.totalSpendUsd).toBe(2.0);
      expect(key1?.requestCount).toBe(2);
      expect(key2?.totalSpendUsd).toBe(2.0);
      expect(key2?.requestCount).toBe(1);
    });
  });

  describe("least-used strategy", () => {
    test("prefers key with lowest request count", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "least-used" });

      // Use key-1 twice
      manager.recordCost("key-1", 1.0);
      manager.recordCost("key-1", 1.0);

      // Use key-2 once
      manager.recordCost("key-2", 1.0);

      // Next selection should prefer key-2 (least used)
      const key = manager.getNextKey();
      expect(key?.id).toBe("key-2");
    });
  });

  describe("least-cost strategy", () => {
    test("prefers key with lowest total spend", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "least-cost" });

      // key-1: $3.0 total
      manager.recordCost("key-1", 2.0);
      manager.recordCost("key-1", 1.0);

      // key-2: $1.5 total
      manager.recordCost("key-2", 1.5);

      // Next selection should prefer key-2 (least cost)
      const key = manager.getNextKey();
      expect(key?.id).toBe("key-2");
    });
  });

  describe("getKeyHealth", () => {
    test("returns sanitized health status without envVar", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";
      process.env.ANTHROPIC_API_KEY_2 = "sk-ant-key2";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.recordCost("key-1", 1.0);
      manager.markRateLimited("key-2", 5000);

      const health = manager.getKeyHealth();

      expect(health).toHaveLength(2);
      expect(health[0]).toHaveProperty("id");
      expect(health[0]).toHaveProperty("isAvailable");
      expect(health[0]).toHaveProperty("totalSpendUsd");
      expect(health[0]).toHaveProperty("requestCount");
      expect(health[0]).toHaveProperty("lastUsed");

      // envVar must NOT be exposed in health output
      expect(health[0]).not.toHaveProperty("envVar");
      expect(health[1]).not.toHaveProperty("envVar");

      // key-1 should be available
      const key1 = health.find((k) => k.id === "key-1");
      expect(key1?.isAvailable).toBe(true);
      expect(key1?.totalSpendUsd).toBe(1.0);

      // key-2 should be rate-limited
      const key2 = health.find((k) => k.id === "key-2");
      expect(key2?.isAvailable).toBe(false);
      expect(key2?.rateLimitedUntil).toBeGreaterThan(Date.now());
    });
  });

  describe("hasAvailableKeys", () => {
    test("returns true when keys are available", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";

      const manager = new KeyManager({ strategy: "round-robin" });

      expect(manager.hasAvailableKeys()).toBe(true);
    });

    test("returns false when all keys are rate-limited", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-key1";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.markRateLimited("key-1", 5000);

      expect(manager.hasAvailableKeys()).toBe(false);
    });
  });

  describe("getKeyValue", () => {
    test("returns key value from environment", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

      const manager = new KeyManager({ strategy: "round-robin" });

      const value = manager.getKeyValue("key-1");
      expect(value).toBe("sk-ant-test-key");
    });

    test("returns undefined for rate-limited key", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

      const manager = new KeyManager({ strategy: "round-robin" });

      manager.markRateLimited("key-1", 5000);

      const value = manager.getKeyValue("key-1");
      expect(value).toBeUndefined();
    });

    test("returns undefined for non-existent key", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

      const manager = new KeyManager({ strategy: "round-robin" });

      const value = manager.getKeyValue("key-999");
      expect(value).toBeUndefined();
    });
  });
});

describe("isRateLimitError", () => {
  test("detects 429 status code in output", () => {
    expect(isRateLimitError(1, ["Error: Request failed with status 429"])).toBe(true);
  });

  test("detects rate_limit_error in output", () => {
    expect(isRateLimitError(1, ['{"type":"error","error":{"type":"rate_limit_error"}}'])).toBe(
      true,
    );
  });

  test("detects 'rate limit' in output", () => {
    expect(isRateLimitError(1, ["API rate limit exceeded, please wait"])).toBe(true);
  });

  test("detects 'too many requests' in output", () => {
    expect(isRateLimitError(1, ["Error: Too Many Requests"])).toBe(true);
  });

  test("detects overloaded_error in output", () => {
    expect(isRateLimitError(1, ['{"type":"error","error":{"type":"overloaded_error"}}'])).toBe(
      true,
    );
  });

  test("returns false for exit code 0", () => {
    expect(isRateLimitError(0, ["429 rate_limit_error"])).toBe(false);
  });

  test("returns false for non-rate-limit errors", () => {
    expect(isRateLimitError(1, ["Error: authentication_error"])).toBe(false);
  });

  test("returns false for empty output", () => {
    expect(isRateLimitError(1, [])).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  test("parses retry-after header value", () => {
    expect(parseRetryAfter(["retry-after: 60"])).toBe(60000);
  });

  test("parses Retry-After header (case-insensitive)", () => {
    expect(parseRetryAfter(["Retry-After: 30"])).toBe(30000);
  });

  test("parses prose form 'retry after N seconds'", () => {
    expect(parseRetryAfter(["Please retry after 45 seconds"])).toBe(45000);
  });

  test("returns undefined when no retry-after found", () => {
    expect(parseRetryAfter(["Some other error message"])).toBeUndefined();
  });

  test("returns undefined for empty output", () => {
    expect(parseRetryAfter([])).toBeUndefined();
  });
});
