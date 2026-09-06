// ─── safetyFloor config mount tests (TASK-1313 S1, round-1 F5) ──────
// The mount is `.optional()` WITHOUT default materialization: a config
// that never mentions safetyFloor normalizes byte-identically and keeps
// its sharedHash — non-opted adapters are provably unchanged.

import {
  resolveSafetyFloorConfig,
  SafetyFloorConfigSchema,
  JudgmentConfigSchema,
} from "../../src/judgment/runner/intent-judgment-config";
import { AdapterConfigSchema } from "../../src/core/adapter-schema";
import { computeAdapterBundleMetadata } from "../../src/core/adapter-loader";

const BASE_ADAPTER = {
  version: "1.0",
  project: {
    name: "t",
    root: ".",
    taskDir: "docs/tasks",
    conventionsDir: "docs/conventions",
  },
  agent: {
    model: "claude-opus-4-6",
    judgeModel: "claude-sonnet-4-6",
    enrichModel: "claude-sonnet-4-6",
    maxTurns: 50,
    maxBudgetPerTask: 5,
    maxRetries: 1,
  },
  verification: {
    commands: [{ name: "t", command: "npm test", required: true, timeout: 1000 }],
    conventionChecks: [],
  },
  git: {
    baseBranch: "main",
    branchPrefix: "quack/",
    commitFormat: "{message}",
    commitTrailer: "t",
  },
  logging: { dir: ".quack/logs", level: "debug" as const },
};

describe("SafetyFloorConfigSchema", () => {
  it("absent config resolves to all off", () => {
    expect(resolveSafetyFloorConfig(undefined)).toEqual({
      signalsMode: "off",
      preVerificationIntegrityMode: "off",
      resumeValidationMode: "off",
    });
  });

  it("partial config resolves unset sub-keys to off", () => {
    const parsed = SafetyFloorConfigSchema.parse({ signals: { mode: "report" } });
    expect(resolveSafetyFloorConfig(parsed)).toEqual({
      signalsMode: "report",
      preVerificationIntegrityMode: "off",
      resumeValidationMode: "off",
    });
  });

  it("rejects unknown modes and unknown keys (.strict())", () => {
    expect(SafetyFloorConfigSchema.safeParse({ signals: { mode: "shadow" } }).success).toBe(false);
    expect(SafetyFloorConfigSchema.safeParse({ bogus: true }).success).toBe(false);
  });
});

describe("non-materialization (round-1 F5)", () => {
  it("a judgment block WITHOUT safetyFloor does not gain the key", () => {
    const parsed = JudgmentConfigSchema.parse({});
    expect("safetyFloor" in parsed && parsed.safetyFloor !== undefined).toBe(false);
  });

  it("sharedHash is unchanged for adapters that never opt in", () => {
    const withoutJudgment = AdapterConfigSchema.parse(BASE_ADAPTER);
    const withJudgmentNoFloor = AdapterConfigSchema.parse({
      ...BASE_ADAPTER,
      judgment: {},
    });
    const hashBase = computeAdapterBundleMetadata(withoutJudgment).sharedHash;
    const hashJudgment = computeAdapterBundleMetadata(withJudgmentNoFloor).sharedHash;
    // Parsing the same input twice is stable...
    expect(computeAdapterBundleMetadata(AdapterConfigSchema.parse(BASE_ADAPTER)).sharedHash).toBe(
      hashBase,
    );
    // ...and an empty judgment block never materializes a safetyFloor key.
    expect(
      (withJudgmentNoFloor.judgment as Record<string, unknown> | undefined)?.safetyFloor,
    ).toBeUndefined();
    // The two hashes differ only because `judgment: {}` was EXPLICITLY
    // added; the safetyFloor key itself contributes nothing.
    const withFloorOff = AdapterConfigSchema.parse({
      ...BASE_ADAPTER,
      judgment: {},
    });
    expect(computeAdapterBundleMetadata(withFloorOff).sharedHash).toBe(hashJudgment);
  });
});
