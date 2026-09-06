// ─── Signal injection tests (TASK-1313) ─────────────────────────────

import { factsToSignals } from "../../../src/judgment/producers/signal-injection";
import { reduceJudgment } from "../../../src/judgment/judgment-reducer";
import type { SealConformanceSummary } from "../../../src/judgment/producers/seal-conformance";
import type { SecretScanSummary } from "../../../src/judgment/producers/secret-scan";

const TIER_S_FACT = {
  kind: "seal_conformance_path" as const,
  path: ".quack/verify.js",
  status: "M",
  classification: "machinery_tier_s" as const,
  candidateSafetyCode: "machinery_tamper" as const,
};

const TIER_R_FACT = {
  kind: "seal_conformance_path" as const,
  path: "package.json",
  status: "M",
  classification: "verification_tier_r" as const,
};

const DENIED_PATH_FACT = {
  kind: "seal_conformance_path" as const,
  path: ".env.production",
  status: "A",
  classification: "denied_path" as const,
};

const OUTSIDE_WRITABLE_FACT = {
  kind: "seal_conformance_path" as const,
  path: "infra/outside.ts",
  status: "M",
  classification: "outside_writable" as const,
};

const conformance = (facts: SealConformanceSummary["facts"]): SealConformanceSummary => ({
  tierSCount: facts.filter((f) => f.classification === "machinery_tier_s").length,
  tierRCount: facts.filter((f) => f.classification === "verification_tier_r").length,
  deniedPathCount: facts.filter((f) => f.classification === "denied_path").length,
  outsideWritableCount: facts.filter((f) => f.classification === "outside_writable").length,
  cleanCount: 0,
  facts,
});

const SAFETY_SECRET: SecretScanSummary = {
  safetyCount: 1,
  humanReviewCount: 0,
  findings: [
    {
      kind: "secret",
      tier: "safety",
      patternId: "github_token",
      file: "src/x.ts",
      line: 3,
      maskedExcerpt: "ghp_…(40 chars)",
      candidateSafetyCode: "secret_exposure",
    },
  ],
};

describe("factsToSignals — mode matrix", () => {
  it("off mode injects nothing", () => {
    expect(factsToSignals("judge", { sealConformance: conformance([TIER_S_FACT]) }, "off")).toEqual(
      [],
    );
  });

  it("report mode demotes safety-tier facts to human_review", () => {
    const signals = factsToSignals(
      "judge",
      { sealConformance: conformance([TIER_S_FACT]), secretScan: SAFETY_SECRET },
      "report",
    );
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal.disposition).toBe("human_review");
      expect(signal.safetyCode).toBeUndefined();
    }
  });

  it("enforce mode promotes candidate-coded facts to safety with the code", () => {
    const signals = factsToSignals(
      "loop_diff",
      { sealConformance: conformance([TIER_S_FACT]), secretScan: SAFETY_SECRET },
      "enforce",
    );
    expect(signals.map((s) => s.disposition)).toEqual(["safety", "safety"]);
    expect(signals.map((s) => s.safetyCode)).toEqual(["machinery_tamper", "secret_exposure"]);
  });

  it("PRECISION INVARIANT: code-less facts never acquire safety disposition in ANY mode", () => {
    for (const mode of ["report", "enforce"] as const) {
      const signals = factsToSignals(
        "judge",
        {
          sealConformance: conformance([TIER_R_FACT]),
          workerFacts: [
            {
              kind: "deploy",
              tier: "shape_only",
              verb: "kubectl apply",
              segment: "kubectl apply -f x.yaml",
            },
            {
              kind: "branch_mutation",
              mutationClass: "write",
              verb: "commit",
              segment: "git commit -m x",
            },
          ],
        },
        mode,
      );
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(signal.disposition).not.toBe("safety");
        expect(signal.safetyCode).toBeUndefined();
      }
    }
  });

  it("full code-less shape matrix maps to producer tiering, never safety (round-2 F10)", () => {
    const humanReviewSecret: SecretScanSummary = {
      safetyCount: 0,
      humanReviewCount: 1,
      findings: [
        {
          kind: "secret",
          tier: "human_review",
          patternId: "generic_api_key",
          file: "src/config.ts",
          line: 12,
          maskedExcerpt: "sk_l…(28 chars)",
        },
      ],
    };
    for (const mode of ["report", "enforce"] as const) {
      const signals = factsToSignals(
        "judge",
        {
          sealConformance: conformance([DENIED_PATH_FACT, OUTSIDE_WRITABLE_FACT, TIER_R_FACT]),
          secretScan: humanReviewSecret,
        },
        mode,
      );
      expect(signals.map((s) => [s.code, s.disposition])).toEqual([
        ["seal_denied_path", "human_review"],
        ["seal_outside_writable", "human_review"],
        ["seal_verification_tier_r", "advisory"],
        ["secret_generic_api_key", "human_review"],
      ]);
      for (const signal of signals) {
        expect(signal.safetyCode).toBeUndefined();
      }
    }
  });

  it("enforce-mode signals force stop through the REAL reducer", () => {
    const signals = factsToSignals(
      "judge",
      { sealConformance: conformance([TIER_S_FACT]) },
      "enforce",
    );
    const decision = reduceJudgment({
      stage: "judge",
      signals,
      judgment: { source: "legacy_policy", action: "continue", rationale: ["ok"] },
    });
    expect(decision.action).toBe("stop");
    expect(decision.safetyFloor.passed).toBe(false);
  });

  it("report-mode signals do NOT stop the reducer", () => {
    const signals = factsToSignals(
      "judge",
      { sealConformance: conformance([TIER_S_FACT]) },
      "report",
    );
    const decision = reduceJudgment({
      stage: "judge",
      signals,
      judgment: { source: "legacy_policy", action: "continue", rationale: ["ok"] },
    });
    expect(decision.action).toBe("continue");
  });

  it("evidence carries only masked/truncated fields", () => {
    const signals = factsToSignals("judge", { secretScan: SAFETY_SECRET }, "enforce");
    expect(JSON.stringify(signals)).toContain("ghp_…(40 chars)");
    expect(signals[0].evidence).toContain("src/x.ts");
  });

  it("stage tags every signal source", () => {
    const signals = factsToSignals(
      "loop_diff",
      { sealConformance: conformance([TIER_S_FACT, TIER_R_FACT]) },
      "report",
    );
    for (const signal of signals) expect(signal.source).toBe("loop_diff");
  });
});
