// ─── TASK-1305: reviewer config schema — defaults + strictness ──────

import { ReviewerRunnerConfigSchema } from "../../src/review/reviewer-config";
import { createReviewerRunner } from "../../src/review/reviewer-runner";

describe("ReviewerRunnerConfigSchema", () => {
  it("fills full safe defaults from an empty object", () => {
    const config = ReviewerRunnerConfigSchema.parse({});
    expect(config.runner).toBe("claude-sdk");
    expect(config.maxTurns).toBe(30);
    expect(config.timeoutMs).toBe(600_000);
    expect(config.codex.binaryPath).toBe("codex");
    expect(config.codex.sandbox).toBe("read-only");
    expect(config.codex.codexHome).toBeUndefined();
    expect(config.codex.profile).toBeUndefined();
    expect(config.codex.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it("defaults the codex sandbox when only binaryPath is given", () => {
    const config = ReviewerRunnerConfigSchema.parse({
      codex: { binaryPath: "C:/tools/codex.cmd" },
    });
    expect(config.codex.sandbox).toBe("read-only");
    expect(config.codex.binaryPath).toBe("C:/tools/codex.cmd");
  });

  it("cannot represent any sandbox value other than read-only", () => {
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        codex: { sandbox: "danger-full-access" },
      }),
    ).toThrow();
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        codex: { sandbox: "workspace-write" },
      }),
    ).toThrow();
  });

  it("rejects unknown keys at the top level (strict)", () => {
    expect(() => ReviewerRunnerConfigSchema.parse({ extraArgs: ["--full-auto"] })).toThrow();
    expect(() => ReviewerRunnerConfigSchema.parse({ sanbox: "x" })).toThrow();
  });

  it("rejects unknown keys inside codex (strict) — extraArgs is unrepresentable", () => {
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        codex: { extraArgs: ["--sandbox", "danger-full-access"] },
      }),
    ).toThrow();
  });

  it("accepts a named Codex profile without opening an argv escape hatch", () => {
    const config = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      codex: { profile: "openai" },
    });
    expect(config.codex.profile).toBe("openai");
  });

  it("accepts a safe provider id and rejects config syntax", () => {
    expect(
      ReviewerRunnerConfigSchema.parse({
        runner: "codex-cli",
        codex: { provider: "openai" },
      }).codex.provider,
    ).toBe("openai");
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        runner: "codex-cli",
        codex: { provider: 'openai"; sandbox="danger-full-access' },
      }),
    ).toThrow();
  });

  it("accepts only a safe non-Quack credential environment name", () => {
    expect(
      ReviewerRunnerConfigSchema.parse({
        runner: "codex-cli",
        codex: { credentialEnvVar: "AZURE_OPENAI_API_KEY" },
      }).codex.credentialEnvVar,
    ).toBe("AZURE_OPENAI_API_KEY");
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        runner: "codex-cli",
        codex: { credentialEnvVar: "QUACK_SERVICE_TOKEN" },
      }),
    ).toThrow();
    expect(() =>
      ReviewerRunnerConfigSchema.parse({
        runner: "codex-cli",
        codex: { credentialEnvVar: "OPENAI_API_KEY;rm" },
      }),
    ).toThrow();
  });

  it("rejects an unknown runner kind", () => {
    expect(() => ReviewerRunnerConfigSchema.parse({ runner: "gemini-cli" })).toThrow();
  });
});

describe("createReviewerRunner (construction is the only throwing surface)", () => {
  it("returns a claude-sdk runner by default", () => {
    const runner = createReviewerRunner();
    expect(runner.kind).toBe("claude-sdk");
    expect(typeof runner.run).toBe("function");
  });

  it("returns a codex-cli runner when configured", () => {
    const runner = createReviewerRunner({ runner: "codex-cli" });
    expect(runner.kind).toBe("codex-cli");
  });

  it("throws loudly on invalid config", () => {
    expect(() => createReviewerRunner({ runner: "codex-cli", extra: true })).toThrow();
    expect(() => createReviewerRunner({ codex: { sandbox: "danger-full-access" } })).toThrow();
  });
});
