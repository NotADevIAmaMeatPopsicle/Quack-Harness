import type {
  CacheMetrics,
  SessionCompletePayload,
  EventStage,
} from "../../src/monitor/event-types";

describe("CacheMetrics", () => {
  it("should accept valid cache metrics data", () => {
    const metrics: CacheMetrics = {
      cacheReadInputTokens: 50000,
      cacheCreationInputTokens: 10000,
      uncachedInputTokens: 5000,
      cacheHitRate: 77,
    };

    expect(metrics.cacheReadInputTokens).toBe(50000);
    expect(metrics.cacheCreationInputTokens).toBe(10000);
    expect(metrics.uncachedInputTokens).toBe(5000);
    expect(metrics.cacheHitRate).toBe(77);
  });

  it("should support zero values for no cache activity", () => {
    const metrics: CacheMetrics = {
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      uncachedInputTokens: 25000,
      cacheHitRate: 0,
    };

    expect(metrics.cacheHitRate).toBe(0);
    expect(metrics.uncachedInputTokens).toBe(25000);
  });

  it("should support 100% hit rate", () => {
    const metrics: CacheMetrics = {
      cacheReadInputTokens: 100000,
      cacheCreationInputTokens: 0,
      uncachedInputTokens: 0,
      cacheHitRate: 100,
    };

    expect(metrics.cacheHitRate).toBe(100);
  });
});

describe("SessionCompletePayload with cacheMetrics", () => {
  it("should allow cacheMetrics as optional field", () => {
    const payloadWithoutCache: SessionCompletePayload = {
      outcome: "approved",
      durationMs: 60000,
      totalCostUsd: 2.5,
    };
    expect(payloadWithoutCache.cacheMetrics).toBeUndefined();
  });

  it("should include cacheMetrics when provided", () => {
    const payload: SessionCompletePayload = {
      outcome: "approved",
      durationMs: 60000,
      totalCostUsd: 2.5,
      cacheMetrics: {
        cacheReadInputTokens: 80000,
        cacheCreationInputTokens: 15000,
        uncachedInputTokens: 5000,
        cacheHitRate: 80,
      },
    };

    expect(payload.cacheMetrics).toBeDefined();
    expect(payload.cacheMetrics!.cacheHitRate).toBe(80);
  });
});

describe("EventStage includes cache_metrics", () => {
  it("should accept cache_metrics as a valid stage", () => {
    const stage: EventStage = "cache_metrics";
    expect(stage).toBe("cache_metrics");
  });
});
