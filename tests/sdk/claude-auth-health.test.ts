import { KeyManager } from "../../src/dispatcher/key-manager";
import { buildClaudeChildEnvironment, selectClaudeApiKey } from "../../src/sdk/claude-auth";
import {
  ClaudeAuthHealthProbe,
  ProjectClaudeAuthProbeCache,
} from "../../src/sdk/claude-auth-health";

interface Message {
  type: string;
  subtype?: string;
  errors?: string[];
}
function queryReturning(message?: Message) {
  return jest.fn(
    (_input: { prompt: string; options: Record<string, unknown> }): AsyncGenerator<Message, void> =>
      (async function* () {
        await Promise.resolve();
        if (message) yield message;
      })(),
  );
}

describe("bounded cached Claude auth probes", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports credential presence or CLI-managed login as unprobed without calling a provider", () => {
    const query = queryReturning({ type: "result", subtype: "success" });
    const health = new ClaudeAuthHealthProbe({ query });
    for (let index = 0; index < 20; index++) {
      expect(health.snapshot({ CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" })).toMatchObject({
        configuration: { mode: "oauth", oauthTokenPresent: true },
        probe: { status: "unprobed" },
        ready: null,
      });
    }
    expect(health.snapshot({ HOME: "/fixture/login" })).toMatchObject({
      configuration: { mode: "cli-managed" },
      ready: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("exposes a dual-credential conflict and refuses the explicit probe before SDK execution", async () => {
    const query = queryReturning({ type: "result", subtype: "success" });
    const health = new ClaudeAuthHealthProbe({ query });
    const environment = {
      ANTHROPIC_API_KEY: "fixture-api",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    };
    expect(health.snapshot(environment)).toMatchObject({
      configuration: { mode: "conflict" },
      ready: false,
    });
    await expect(health.probe(environment)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("Both Anthropic API keys") as unknown,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("deduplicates explicit requests, caches real result evidence, and preserves probe bounds", async () => {
    const query = queryReturning({ type: "result", subtype: "success" });
    const health = new ClaudeAuthHealthProbe({ query });
    const environment = { ANTHROPIC_API_KEY: "fixture-api" };
    const results = await Promise.all([health.probe(environment), health.probe(environment)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      status: "passed",
      checkedAt: expect.any(String) as unknown,
      expiresAt: expect.any(String) as unknown,
      coverage: "selected-credential",
    });
    await health.probe(environment);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].options).toMatchObject({
      maxTurns: 3,
      maxBudgetUsd: 0.05,
      tools: [],
      env: { ANTHROPIC_API_KEY: "fixture-api", CLAUDE_CODE_OAUTH_TOKEN: undefined },
    });
    expect(health.snapshot(environment).ready).toBe(true);
  });

  it.each([
    [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["credential fixture-api rejected"],
      },
      "failed",
    ],
    [undefined, "failed"],
  ] as const)(
    "retains unsuccessful real probe outcomes and sanitizes provider diagnostics",
    async (message, status) => {
      const query = queryReturning(
        message ? { ...message, errors: [...message.errors] } : undefined,
      );
      const health = new ClaudeAuthHealthProbe({ query });
      const environment = { ANTHROPIC_API_KEY: "fixture-api" };
      const result = await health.probe(environment);
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("fixture-api");
      expect(health.snapshot(environment).ready).toBe(false);
    },
  );

  it("invalidates cached proof when credentials change or expire", async () => {
    let now = Date.parse("2026-09-11T00:00:00Z");
    const query = queryReturning({ type: "result", subtype: "success" });
    const health = new ClaudeAuthHealthProbe({ query, now: () => now, ttlMs: 1000 });
    await health.probe({ ANTHROPIC_API_KEY: "fixture-first" });
    expect(health.snapshot({ ANTHROPIC_API_KEY: "fixture-second" }).ready).toBeNull();
    await health.probe({ ANTHROPIC_API_KEY: "fixture-second" });
    now += 1001;
    expect(health.snapshot({ ANTHROPIC_API_KEY: "fixture-second" }).probe.status).toBe("unprobed");
    await health.probe({ ANTHROPIC_API_KEY: "fixture-second" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not report readiness when a successful probe cannot close cleanly", async () => {
    const query = jest.fn(() =>
      Object.assign(
        (async function* () {
          await Promise.resolve();
          yield { type: "result", subtype: "success" };
        })(),
        {
          close: () => {
            throw new Error("cleanup rejected fixture-api");
          },
        },
      ),
    );
    const environment = { ANTHROPIC_API_KEY: "fixture-api" };
    const health = new ClaudeAuthHealthProbe({ query });
    await expect(health.probe(environment)).resolves.toMatchObject({
      status: "failed",
      error: "Claude probe cleanup failed: cleanup rejected [redacted]",
    });
    expect(health.snapshot(environment).ready).toBe(false);
  });

  it("does not reuse an in-flight result for a different credential generation", async () => {
    const query = queryReturning({ type: "result", subtype: "success" });
    const health = new ClaudeAuthHealthProbe({ query });
    await Promise.all([
      health.probe({ ANTHROPIC_API_KEY: "fixture-first" }),
      health.probe({ ANTHROPIC_API_KEY: "fixture-second" }),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect((query.mock.calls[1][0].options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBe(
      "fixture-second",
    );
  });

  it("aborts and closes a timed-out probe without leaving its deadline timer", async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const close = jest.fn();
    const query = jest.fn((input: { prompt: string; options: Record<string, unknown> }) => {
      signal = (input.options.abortController as AbortController).signal;
      return {
        next: () => new Promise<IteratorResult<Message, void>>(() => undefined),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
        throw: (error: unknown) =>
          Promise.reject(error instanceof Error ? error : new Error(String(error))),
        [Symbol.asyncIterator]() {
          return this;
        },
        close,
      };
    });
    const health = new ClaudeAuthHealthProbe({ query, timeoutMs: 100 });
    const pending = health.probe({});
    await jest.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ status: "timed_out" });
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("bounds SDK loading and never starts a paid query after its deadline", async () => {
    jest.useFakeTimers();
    const query = queryReturning({ type: "result", subtype: "success" });
    let release: ((query: ReturnType<typeof queryReturning>) => void) | undefined;
    const loadQuery = () =>
      new Promise<ReturnType<typeof queryReturning>>((resolve) => {
        release = resolve;
      });
    const health = new ClaudeAuthHealthProbe({ loadQuery, timeoutMs: 100 });
    const pending = health.probe({});
    await jest.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({ status: "timed_out" });
    release!(query);
    await Promise.resolve();
    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("trusted project auth probe generation", () => {
  it("re-probes a changed pool under the same project ID and unchanged host environment", async () => {
    const originalEnvironment = process.env;
    process.env = {
      ...process.env,
      ANTHROPIC_API_KEY_1: "fixture-key-one",
      ANTHROPIC_API_KEY_2: "fixture-key-two",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    };
    try {
      const environment = { ...process.env };
      const query = queryReturning({ type: "result", subtype: "success" });
      const cache = new ProjectClaudeAuthProbeCache({ query });
      const firstManager = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_1"] });
      const first = cache.forProject("project", "/fixture", firstManager);
      await first.probe.probe(
        environment,
        () => buildClaudeChildEnvironment(environment, selectClaudeApiKey(firstManager)),
        first.policy,
      );
      expect(first.probe.snapshot(environment, true, first.policy).ready).toBe(true);

      const secondManager = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_2"] });
      const second = cache.forProject("project", "/fixture", secondManager);
      expect(second.probe).not.toBe(first.probe);
      expect(second.probe.snapshot(environment, true, second.policy).ready).toBeNull();
      expect(
        second.probe.snapshot({ ANTHROPIC_API_KEY_1: "fixture-key-one" }, true, second.policy)
          .configuration.apiKeyPresent,
      ).toBe(false);
      await second.probe.probe(
        environment,
        () => buildClaudeChildEnvironment(environment, selectClaudeApiKey(secondManager)),
        second.policy,
      );
      expect(query).toHaveBeenCalledTimes(2);
      expect((query.mock.calls[0][0].options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBe(
        "fixture-key-one",
      );
      expect((query.mock.calls[1][0].options.env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY).toBe(
        "fixture-key-two",
      );
      expect(cache.forProject("project", "/fixture", secondManager)).toBe(second);
      expect(process.env).toEqual(environment);

      cache.delete("project");
      const registeredAgain = cache.forProject("project", "/fixture", secondManager);
      expect(registeredAgain.probe).not.toBe(second.probe);
      expect(
        registeredAgain.probe.snapshot(environment, true, registeredAgain.policy).ready,
      ).toBeNull();
    } finally {
      process.env = originalEnvironment;
    }
  });

  it("does not transfer a pending old-registration result into a replacement probe", async () => {
    const query = queryReturning({ type: "result", subtype: "success" });
    const cache = new ProjectClaudeAuthProbeCache({ query });
    const first = cache.forProject("project", "/fixture", null);
    const pending = first.probe.probe({});
    cache.delete("project");
    const replacement = cache.forProject("project", "/fixture", null);
    await pending;
    expect(replacement.probe.snapshot({}).ready).toBeNull();
  });
});
