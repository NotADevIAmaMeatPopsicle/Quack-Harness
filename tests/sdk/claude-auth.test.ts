import { KeyManager } from "../../src/dispatcher/key-manager";
import {
  buildClaudeChildEnvironment,
  getClaudeSdkEnvironment,
  inspectClaudeAuth,
  selectClaudeApiKey,
  withClaudeAuthScope,
  withClaudeApiKeysScope,
} from "../../src/sdk/claude-auth";

describe("explicit Claude authentication policy", () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = { ...originalEnvironment };
    for (const name of Object.keys(process.env)) {
      if (/^(?:ANTHROPIC_API_KEY(?:_\d+)?|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name))
        delete process.env[name];
    }
  });
  afterEach(() => {
    process.env = originalEnvironment;
  });

  it.each([
    [{ ANTHROPIC_API_KEY: "fixture-api-primary" }, "api-key"],
    [{ CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth" }, "oauth"],
    [{}, "cli-managed"],
  ] as const)(
    "reports presence without claiming a live authentication probe: %s",
    (environment, mode) => {
      expect(inspectClaudeAuth(environment).mode).toBe(mode);
      expect(buildClaudeChildEnvironment(environment)).toMatchObject({
        CLAUDECODE: undefined,
        CLAUDE_CODE: undefined,
      });
    },
  );

  it("refuses both credential families, including case variants and numbered keys", () => {
    const environment = {
      anthropic_api_key_2: "fixture-api-two",
      claude_code_oauth_token: "fixture-oauth",
      QUACK_SELECTED_KEY_ID: "key-2",
    };
    expect(inspectClaudeAuth(environment).mode).toBe("conflict");
    expect(() => buildClaudeChildEnvironment(environment)).toThrow("Both Anthropic API keys");
  });

  it("keeps CLI-managed login available without claiming it is valid", () => {
    const environment = {
      HOME: "/fixture/home",
      CLAUDE_CONFIG_DIR: "/fixture/login",
      CLAUDECODE: "1",
    };
    expect(buildClaudeChildEnvironment(environment)).toMatchObject({
      HOME: "/fixture/home",
      CLAUDE_CONFIG_DIR: "/fixture/login",
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDECODE: undefined,
    });
    expect(environment.CLAUDECODE).toBe("1");
  });

  it("honors the configured pool subset/order and scrubs OAuth plus every unselected key", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      ANTHROPIC_API_KEY_2: "fixture-two",
      ANTHROPIC_API_KEY_3: "fixture-three",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const manager = new KeyManager({
      pool: ["env:ANTHROPIC_API_KEY_3", "env:ANTHROPIC_API_KEY_2"],
      strategy: "round-robin",
    });
    const first = buildClaudeChildEnvironment(process.env, selectClaudeApiKey(manager));
    const second = buildClaudeChildEnvironment(process.env, selectClaudeApiKey(manager));
    expect(first.ANTHROPIC_API_KEY).toBe("fixture-three");
    expect(second.ANTHROPIC_API_KEY).toBe("fixture-two");
    for (const environment of [first, second]) {
      expect(environment.ANTHROPIC_API_KEY_2).toBeUndefined();
      expect(environment.ANTHROPIC_API_KEY_3).toBeUndefined();
      expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-primary");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-oauth");
  });

  it("retains the selected numbered reference only for a trusted Quack child", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      ANTHROPIC_API_KEY_2: "fixture-two",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const manager = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_2"] });
    const environment = buildClaudeChildEnvironment(process.env, selectClaudeApiKey(manager), true);
    expect(environment.ANTHROPIC_API_KEY).toBe("fixture-two");
    expect(environment.ANTHROPIC_API_KEY_2).toBe("fixture-two");
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("preserves primary and numbered legacy rotation", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      ANTHROPIC_API_KEY_2: "fixture-two",
    });
    const manager = new KeyManager({ strategy: "round-robin" });
    expect(selectClaudeApiKey(manager).apiKey).toBe("fixture-primary");
    expect(selectClaudeApiKey(manager).apiKey).toBe("fixture-two");
    expect(selectClaudeApiKey(manager).apiKey).toBe("fixture-primary");
  });

  it("does not fall back from an empty explicit pool to OAuth or an unlisted primary", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const manager = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_2"] });
    expect(() => selectClaudeApiKey(manager)).toThrow("no available key");
    expect(() => new KeyManager({ pool: ["literal-secret"] })).toThrow(
      "named environment references",
    );
    expect(() => new KeyManager({ pool: ["env:NODE_OPTIONS"] })).toThrow(
      "named environment references",
    );
  });

  it("isolates overlapping project scopes and restores the caller's conflict policy", async () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-one",
      ANTHROPIC_API_KEY_2: "fixture-two",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const first = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY"] });
    const second = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_2"] });
    const result = await Promise.all([
      withClaudeAuthScope(first, async () => {
        await Promise.resolve();
        return getClaudeSdkEnvironment();
      }),
      withClaudeAuthScope(second, async () => {
        await Promise.resolve();
        await Promise.resolve();
        return getClaudeSdkEnvironment();
      }),
    ]);
    expect(result.map((environment) => environment.ANTHROPIC_API_KEY)).toEqual([
      "fixture-one",
      "fixture-two",
    ]);
    expect(result.every((environment) => environment.CLAUDE_CODE_OAUTH_TOKEN === undefined)).toBe(
      true,
    );
    expect(() => getClaudeSdkEnvironment()).toThrow("Both Anthropic API keys");
  });

  it("does not initialize Claude auth for a pipeline that never calls Claude", async () => {
    const result = await withClaudeApiKeysScope(
      { pool: ["not-a-valid-reference"], strategy: "round-robin", cooldownMs: 1000 },
      async () => {
        await Promise.resolve();
        return "codex-only";
      },
    );
    expect(result).toBe("codex-only");
  });

  it.each([{ strategy: "round-robin" }, { pool: [], strategy: "round-robin" }])(
    "requires a real explicit pool to bypass a dual-auth conflict: %j",
    (config) => {
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: "fixture-api",
        CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
      });
      expect(() =>
        // Exercise the runtime guard against incomplete programmatic configuration too.
        getClaudeSdkEnvironment(config as unknown as Parameters<typeof getClaudeSdkEnvironment>[0]),
      ).toThrow("Both Anthropic API keys");
    },
  );

  it("does not treat a default KeyManager as explicit pool authority", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-api",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const manager = new KeyManager({ strategy: "round-robin" });
    expect(() => withClaudeAuthScope(manager, () => getClaudeSdkEnvironment())).toThrow(
      "Both Anthropic API keys",
    );
    expect(() => buildClaudeChildEnvironment(process.env, selectClaudeApiKey(manager))).toThrow(
      "Both Anthropic API keys",
    );
  });
});
