// ─── API Key Manager ────────────────────────────────────────────────
// Manages a pool of Anthropic API keys for rate limit resilience.
// Supports multiple keys via env vars (ANTHROPIC_API_KEY, _2, _3, etc.)
// and rotates through them based on configurable strategies.

export interface ApiKeyState {
  id: string; // "key-1", "key-2", etc.
  envVar: string; // "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_2", etc.
  isAvailable: boolean;
  rateLimitedUntil?: number; // Timestamp (ms since epoch)
  totalSpendUsd: number;
  requestCount: number;
  lastUsed: number; // Timestamp (ms since epoch)
}

export interface KeyManagerConfig {
  /** Explicit environment references; omitted retains the legacy numbered pool. */
  pool?: string[];
  strategy: "round-robin" | "least-used" | "least-cost";
  cooldownMs: number;
}

const DEFAULT_CONFIG: KeyManagerConfig = {
  strategy: "round-robin",
  cooldownMs: 60000, // 1 minute default cooldown
};

export class KeyManager {
  private keys: Map<string, ApiKeyState> = new Map();
  private lastUsedIndex = -1; // Start at -1 so first call returns index 0
  private config: KeyManagerConfig;

  constructor(config?: Partial<KeyManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadKeysFromEnv();
  }

  /**
   * Load API keys from environment variables.
   * Looks for ANTHROPIC_API_KEY, ANTHROPIC_API_KEY_2, ANTHROPIC_API_KEY_3, etc.
   */
  private loadKeysFromEnv(): void {
    if (this.config.pool !== undefined) {
      if (
        !Array.isArray(this.config.pool) ||
        this.config.pool.length === 0 ||
        this.config.pool.some((entry) => !/^env:ANTHROPIC_API_KEY(?:_\d+)?$/.test(entry))
      ) {
        throw new Error(
          "agent.apiKeys.pool must contain named environment references such as env:ANTHROPIC_API_KEY",
        );
      }
      const names = [...new Set(this.config.pool.map((entry) => entry.slice(4)))];
      names.forEach((envVar, index) => {
        if (!process.env[envVar]?.trim()) return;
        const id = `key-${index + 1}`;
        this.keys.set(id, {
          id,
          envVar,
          isAvailable: true,
          totalSpendUsd: 0,
          requestCount: 0,
          lastUsed: 0,
        });
      });
      return;
    }
    // Load primary key
    const primaryKey = process.env.ANTHROPIC_API_KEY;
    if (primaryKey) {
      this.keys.set("key-1", {
        id: "key-1",
        envVar: "ANTHROPIC_API_KEY",
        isAvailable: true,
        totalSpendUsd: 0,
        requestCount: 0,
        lastUsed: 0,
      });
    }

    // Load additional keys (_2, _3, etc.)
    let index = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const envVarName = `ANTHROPIC_API_KEY_${index}`;
      const key = process.env[envVarName];
      if (!key) break;

      this.keys.set(`key-${index}`, {
        id: `key-${index}`,
        envVar: envVarName,
        isAvailable: true,
        totalSpendUsd: 0,
        requestCount: 0,
        lastUsed: 0,
      });

      index++;
    }
  }

  /**
   * Get the next available key using the configured strategy.
   * Returns null if all keys are rate-limited.
   */
  getNextKey(): ApiKeyState | null {
    // Check for expired rate limits
    this.updateKeyAvailability();

    const availableKeys = Array.from(this.keys.values()).filter((k) => k.isAvailable);

    if (availableKeys.length === 0) {
      return null; // All keys rate-limited
    }

    switch (this.config.strategy) {
      case "round-robin":
        return this.selectRoundRobin(availableKeys);
      case "least-used":
        return this.selectLeastUsed(availableKeys);
      case "least-cost":
        return this.selectLeastCost(availableKeys);
      default:
        return this.selectRoundRobin(availableKeys);
    }
  }

  /**
   * Get the actual key value from environment for a given key ID.
   * Returns undefined if the key doesn't exist or isn't available.
   */
  getKeyValue(keyId: string): string | undefined {
    const keyState = this.keys.get(keyId);
    if (!keyState || !keyState.isAvailable) {
      return undefined;
    }
    return process.env[keyState.envVar];
  }

  /** Names only, for child credential filtering and private probe cache invalidation. */
  getEnvironmentNames(): string[] {
    return this.config.pool
      ? [...new Set(this.config.pool.map((reference) => reference.slice(4)))]
      : [...this.keys.values()].map((key) => key.envVar);
  }

  hasExplicitPool(): boolean {
    return Array.isArray(this.config.pool) && this.config.pool.length > 0;
  }

  /**
   * Mark a key as rate-limited with optional retry-after cooldown.
   * @param keyId Key ID to mark as rate-limited
   * @param retryAfterMs Optional retry-after duration in ms (defaults to config.cooldownMs)
   */
  markRateLimited(keyId: string, retryAfterMs?: number): void {
    const key = this.keys.get(keyId);
    if (!key) return;

    const cooldown = retryAfterMs ?? this.config.cooldownMs;
    key.isAvailable = false;
    key.rateLimitedUntil = Date.now() + cooldown;
  }

  /**
   * Record cost and usage against a specific key.
   */
  recordCost(keyId: string, costUsd: number): void {
    const key = this.keys.get(keyId);
    if (!key) return;

    key.totalSpendUsd += costUsd;
    key.requestCount++;
    key.lastUsed = Date.now();
  }

  /**
   * Get health status of all keys (sanitized — no actual key values or env var names).
   */
  getKeyHealth(): Omit<ApiKeyState, "envVar">[] {
    this.updateKeyAvailability();
    return Array.from(this.keys.values()).map((k) => ({
      id: k.id,
      isAvailable: k.isAvailable,
      rateLimitedUntil: k.rateLimitedUntil,
      totalSpendUsd: k.totalSpendUsd,
      requestCount: k.requestCount,
      lastUsed: k.lastUsed,
    }));
  }

  /**
   * Check if any keys are available.
   */
  hasAvailableKeys(): boolean {
    this.updateKeyAvailability();
    return Array.from(this.keys.values()).some((k) => k.isAvailable);
  }

  /**
   * Update key availability based on expired cooldowns.
   */
  private updateKeyAvailability(): void {
    const now = Date.now();
    for (const key of this.keys.values()) {
      if (!key.isAvailable && key.rateLimitedUntil && key.rateLimitedUntil <= now) {
        key.isAvailable = true;
        key.rateLimitedUntil = undefined;
      }
    }
  }

  /**
   * Round-robin selection: rotate through available keys in order.
   */
  private selectRoundRobin(availableKeys: ApiKeyState[]): ApiKeyState {
    // Convert Map keys to array and find available indices
    const allKeys = Array.from(this.keys.values());
    const availableIndices = availableKeys
      .map((k) => allKeys.findIndex((ak) => ak.id === k.id))
      .filter((idx) => idx >= 0);

    // Find the next available index after lastUsedIndex
    let selectedIdx = availableIndices.find((idx) => idx > this.lastUsedIndex);
    if (selectedIdx === undefined) {
      // Wrap around to the first available
      selectedIdx = availableIndices[0];
    }

    this.lastUsedIndex = selectedIdx;
    return allKeys[selectedIdx];
  }

  /**
   * Least-used selection: prefer the key with the lowest request count.
   */
  private selectLeastUsed(availableKeys: ApiKeyState[]): ApiKeyState {
    return availableKeys.reduce((min, key) => (key.requestCount < min.requestCount ? key : min));
  }

  /**
   * Least-cost selection: prefer the key with the lowest total spend.
   */
  private selectLeastCost(availableKeys: ApiKeyState[]): ApiKeyState {
    return availableKeys.reduce((min, key) => (key.totalSpendUsd < min.totalSpendUsd ? key : min));
  }

  /**
   * Get the configured cooldown in milliseconds.
   */
  getCooldownMs(): number {
    return this.config.cooldownMs;
  }
}

// ─── Rate Limit Detection Utilities ──────────────────────────────────

/**
 * Detect whether a child process failure was caused by an API rate limit.
 * Scans the combined output for 429 status codes and rate_limit_error messages.
 */
export function isRateLimitError(exitCode: number | null, output: string[]): boolean {
  if (exitCode === 0) return false;

  const combined = output.join("\n").toLowerCase();
  return (
    combined.includes("429") ||
    combined.includes("rate_limit_error") ||
    combined.includes("rate limit") ||
    combined.includes("too many requests") ||
    combined.includes("overloaded_error")
  );
}

/**
 * Parse a Retry-After value from error output.
 * Looks for patterns like "retry-after: 60", "Retry-After: 30s", or
 * "retry after 45 seconds" in the output lines.
 * Returns the retry delay in milliseconds, or undefined if not found.
 */
export function parseRetryAfter(output: string[]): number | undefined {
  const combined = output.join("\n");

  // Match "retry-after: <number>" header or similar patterns
  const headerMatch = combined.match(/retry[_-]after[:\s]+(\d+)/i);
  if (headerMatch) {
    const seconds = parseInt(headerMatch[1], 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000; // Convert seconds to ms
    }
  }

  // Match "retry after <number> second(s)" in prose
  const proseMatch = combined.match(/retry\s+after\s+(\d+)\s*(?:second|sec|s\b)/i);
  if (proseMatch) {
    const seconds = parseInt(proseMatch[1], 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  return undefined;
}
